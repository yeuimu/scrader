// temu_accumulate_human.js — Temu 拟人采集（scrader 读取 + cua 真实滚轮/拟人点击）
// 用法: node temu_accumulate_human.js --tab <tabId> --target 200 --out temu_xxx.json --pid <pid> --wid <windowId> [--maxsec 240]
// 分工：读取永远 DOM（零输入事件）；滚动=真实滚轮阅读式节奏；点击=UIA 权威定位+贝塞尔滑行+前台点击
'use strict';
const fs = require('fs');
const path = require('path');
const SCRADER = process.env.SCRADER_HOME || path.resolve(__dirname, '..', '..');  // 仓库根（recipes/temu → 上两级）
const { genHarvestCode } = require(SCRADER + '/core/index.js');
const { createClient, sleep } = require(SCRADER + '/hands/cua/client');
const { humanGlide } = require(SCRADER + '/hands/cua/glide');
const { getGeom, uiaCenterTo } = require(SCRADER + '/hands/cua/geom');
const { callBridge } = require(SCRADER + '/core/lib/router');

// ---- 参数（具名，防位置错序） ----
const args = (() => { const o = {}; const a = process.argv.slice(2); for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1]; return o; })();
const TAB = +args.tab, TARGET = +(args.target || 200), OUT = args.out || 'temu_accum_human.json';
const PID = +args.pid, WID = +args.wid, MAXSEC = +(args.maxsec || 240);
if (!TAB || !PID || !WID) {
  console.error('用法: node temu_accumulate_human.js --tab <tabId> --target 200 --out f.json --pid <pid> --wid <wid> [--maxsec 240]');
  process.exit(1);
}
const evalPage = (code) => callBridge("evaluate", { tabId: TAB, code }, 300000).then((r) => (r && r.json && r.json.data) ?? r);
const rnd = (a, b) => a + Math.random() * (b - a);

// ---- Temu 采集字段（正则避免反斜杠：MSYS 折叠坑） ----
const FIELDS = [
  { key: 'price', pattern: '([0-9][0-9,]*)円', kind: 'int' },
  { key: 'originalPrice', pattern: '原价[ ]*([0-9,]+)円', kind: 'int' },
  { key: 'soldCount', pattern: '已售([0-9,.]+[万KMBkmb]?[+]?)件' },
];

// ---- 阅读式滚动节奏（改"更像人"只动这里） ----
const SCROLL_CFG = {
  BURST_MIN: 3, BURST_MAX: 6,        // 远处：一次连滑 3~6 格
  TICK_GAP_MS: [90, 250],            //   格间
  READING_PAUSE_MS: [1500, 4300],    //   停下"看商品"
  DRIFT_PROB: 0.3,                   //   停顿时手挪一下光标
  REREAD_PROB: 0.15,                 //   回滚一格（回看）
  NEAR_VIEWPORTS: 1.2,               // 距按钮 <1.2 屏 → 切单格慢滚
  NEAR_TICK_GAP_MS: [900, 2400],
  POST_CLICK_WAIT_MS: [2200, 6000],  // 点击"查看更多"后等加载
};

// "查看更多"按钮状态（DOM 启发式：role=button + 视口水平中心，排除侧边栏/SCRIPT）
const BTN_STATE = `
return (() => {
  const zw = /[\\u200b-\\u200d\\u2060\\ufeff]/g;
  let best = null, bd = 1e9;
  for (const el of document.querySelectorAll('[role=button]')) {
    const t = ((el.innerText || '') + '').replace(zw, '').trim();
    if (!/^(查看更多|もっと見る)/.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5) continue;
    const d = Math.abs((r.left + r.right) / 2 - innerWidth / 2);
    if (d < bd) { bd = d; best = r; }
  }
  if (!best) return { found: false, scrollY: Math.round(scrollY), cards: document.querySelectorAll('a[href*=-g-]').length };
  return { found: true, top: Math.round(best.top), bottom: Math.round(best.bottom), cx: Math.round(best.left + best.width / 2), vh: innerHeight, scrollY: Math.round(scrollY), cards: document.querySelectorAll('a[href*=-g-]').length };
})();`;

let resets = 0;

async function scrollWheel(client, lines, direction = 'down') {
  const r = await client.call('scroll', { pid: PID, window_id: WID, direction, by: 'line', amount: lines, delivery_mode: 'foreground' });
  const txt = JSON.stringify(r.content || r);
  if (/provide window_id|error/i.test(txt) && !/✅/.test(txt)) throw new Error('scroll rejected: ' + txt.slice(0, 120));
}

async function driftCursor(client) {
  const p = await client.getPos(); if (!p) return;
  await client.call('move_cursor', { session: client.session, scope: 'desktop',
    x: p[0] + Math.round((Math.random() - 0.5) * 90), y: p[1] + Math.round((Math.random() - 0.5) * 60) });
}

// 阅读式滚动到"查看更多"入视口（实测 0 重置；重置陷阱由"匀速滚轮滚到底"触发）
async function scrollToButtonHuman(client) {
  const t0 = Date.now(); let lastCards = -1, ticks = 0, pauses = 0;
  while (Date.now() - t0 < MAXSEC * 1000) {
    const st = await evalPage(BTN_STATE);
    if (lastCards > 0 && st.cards < lastCards - 20) { resets++; console.log(`  ⚠ 列表重置 ${lastCards}→${st.cards}（第${resets}次）`); }
    lastCards = st.cards;
    if (st.found && st.top > 100 && st.bottom < st.vh - 100) {
      console.log(`  阅读式滚动到位: ${ticks}格/${pauses}次停顿/${Math.round((Date.now() - t0) / 1000)}s, scrollY=${st.scrollY}`);
      return st;
    }
    const distToBtn = st.found ? st.top - st.vh : 1e9;
    if (distToBtn > st.vh * SCROLL_CFG.NEAR_VIEWPORTS) {
      const burst = SCROLL_CFG.BURST_MIN + Math.floor(Math.random() * (SCROLL_CFG.BURST_MAX - SCROLL_CFG.BURST_MIN + 1));
      for (let k = 0; k < burst; k++) { await scrollWheel(client, 1); ticks++; await sleep(rnd(...SCROLL_CFG.TICK_GAP_MS)); }
      await sleep(rnd(...SCROLL_CFG.READING_PAUSE_MS)); pauses++;
      if (Math.random() < SCROLL_CFG.DRIFT_PROB) await driftCursor(client);
      if (Math.random() < SCROLL_CFG.REREAD_PROB) { await scrollWheel(client, 1, 'up'); ticks++; await sleep(600 + Math.random() * 900); }
    } else {
      await scrollWheel(client, 1); ticks++; await sleep(rnd(...SCROLL_CFG.NEAR_TICK_GAP_MS)); pauses++;
    }
  }
  throw new Error('阅读式滚动超时');
}

// UIA 权威定位 → 拟人滑行 → 前台点击
async function humanClickMore(client) {
  const uia = client.parse(await client.call('get_window_state', { pid: PID, window_id: WID, query: 'もっと見る', include_screenshot: false }));
  const els = uia.elements || [];
  const btn = els.find((e) => e.role === 'Button' && /(查看更多|もっと見る)/.test(e.label || '')) || els.find((e) => /(查看更多|もっと見る)/.test(e.label || ''));
  if (!btn || !btn.frame) return { clicked: false, reason: 'uia-no-button', matched: els.length };
  console.log(`  UIA 命中: "${(btn.label || '').slice(0, 16)}" frame=${JSON.stringify(btn.frame)}`);
  const g = await getGeom(client, PID, WID);
  const { png, screen } = uiaCenterTo(g, btn.frame);
  await humanGlide(client, ...screen);
  await sleep(150 + Math.random() * 250);
  await client.call('click', { session: client.session, pid: PID, window_id: WID, x: png[0], y: png[1], delivery_mode: 'foreground' });
  await sleep(rnd(...SCROLL_CFG.POST_CLICK_WAIT_MS));
  return { clicked: true, label: (btn.label || '').slice(0, 12) };
}

(async () => {
  const client = createClient();
  await client.init();

  let map = new Map();
  if (fs.existsSync(OUT)) {
    try { for (const it of JSON.parse(fs.readFileSync(OUT, 'utf8')).items || []) map.set(it.stableId, it); console.log(`续跑：文件已有 ${map.size} 条`); } catch {}
  }
  const merge = (items) => { let nw = 0; for (const it of items || []) if (it.stableId && !map.has(it.stableId)) { map.set(it.stableId, it); nw++; } return nw; };
  const save = () => fs.writeFileSync(OUT, JSON.stringify({ keyword: OUT, items: [...map.values()] }));

  for (let round = 1; map.size < TARGET && round <= 25; round++) {
    // harvest 内部会 scrollTo(0,0) 扫全页并在结束时复位到顶（harvest.js:48/62/74）
    // → 采集前记录 scrollY，采集后程序化瞬跳回原位（瞬跳不触发重置陷阱），真实滚轮只滚新增区间
    const preY = await evalPage('return Math.round(scrollY)');
    const data = await evalPage(genHarvestCode({ itemSelector: "a[href*='-g-']", stableIdPattern: '-g-([0-9]+)[.]html', cardLevels: 4, fields: FIELDS, maxItems: 0 }));
    await evalPage('window.scrollTo(0, ' + preY + '); return Math.round(scrollY)');
    await sleep(500 + Math.random() * 500);
    const items = (data && data.items) || [];
    const nw = merge(items);
    save();
    console.log(`第${round}轮: 采到 ${items.length}, 新增 ${nw}, 累计 ${map.size}/${TARGET}`);
    if (map.size >= TARGET) break;
    await scrollToButtonHuman(client);
    const clk = await humanClickMore(client);
    console.log(`  拟人点击: ${JSON.stringify(clk)}`);
    if (!clk.clicked) { console.log('  未找到按钮，结束'); break; }
    await sleep(400 + Math.random() * 800);
  }
  const items = [...map.values()];
  console.log(`完成: ${items.length} 条 | 缺价格 ${items.filter((x) => x.price == null).length} | 重置 ${resets} 次 | 已保存 ${OUT}`);
  await client.end();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
