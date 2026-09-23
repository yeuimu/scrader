// hands/act/verbs.js — 意图动词：Agent 只说做什么，本层负责怎么定位、带守卫执行、带回效果证据
// 守卫清单（学费已付，全部固化在此）：前台/标题校验、滚动后坐标重测、视口边界、停滞熔断、
// 效果验证（新标签/URL变化/标记入视口/浮层可见）、站点知识自动学习入库
'use strict';
const { humanGlide } = require('../cua/glide');
const { snapshot, sectionImages, evalOn, OVERLAY } = require('./grounding');
const { waitUrlChange } = require('./effects');
const siteCache = require('./site_cache');

const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── cua 几何：窗口 bounds + 截图尺寸 + Document 帧（视口原点）──
async function geom(ctx) {
  const ws = ctx.client.parse(await ctx.client.call('get_window_state', { pid: ctx.pid, window_id: ctx.wid, max_dimension: 400, max_elements: 400 }));
  const b = ws.window_bounds;
  if (!b || b.x === undefined) throw new Error('get_window_state 无 window_bounds');
  const els = ws.elements || [];
  const doc = els.find((e) => (e.role === 'Document' || e.role === 'WebArea' || e.role === 'Pane') && e.frame && e.frame.width > 500)
    || els.find((e) => e.frame && e.frame.width > 500 && e.frame.height > 500) || { frame: { x: 0, y: 112 } };
  return { b, pw: ws.screenshot_width, ph: ws.screenshot_height, vx0: doc.frame.x, vy0: doc.frame.y, title: ws.window_title || '' };
}
function mapV(g, vx, vy) {
  const sx = g.vx0 + vx, sy = g.vy0 + vy;
  return { screen: [Math.round(sx), Math.round(sy)], png: [Math.round((sx - g.b.x) * g.pw / g.b.width), Math.round((sy - g.b.y) * g.ph / g.b.height)] };
}
// 前台保险：激活目标标签 + 窗口置前 + 标题含关键词，共享环境下绝不盲点
async function ensureFront(ctx, tabId, titleRe) {
  await ctx.bridge('activate_tab', { tabId }).catch(() => {});
  await ctx.client.call('bring_to_front', { pid: ctx.pid, window_id: ctx.wid }).catch(() => {});
  await sleep(400);
  for (let k = 0; k < 2; k++) {
    const g = await geom(ctx);
    if (new RegExp(titleRe, 'i').test(g.title)) return true;
    await ctx.client.call('bring_to_front', { pid: ctx.pid, window_id: ctx.wid }).catch(() => {});
    await sleep(800);
  }
  return false;
}
async function glideClick(ctx, g, vx, vy) {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return false;
  const m = mapV(g, vx, vy);
  let glided = false;
  for (let k = 0; k < 2 && !glided; k++) {
    try { const gg = await humanGlide(ctx.client, ...m.screen); glided = gg && gg.waypoints > 0; } catch { await sleep(500); }
  }
  await sleep(rnd(140, 380));
  await ctx.client.call('click', { session: ctx.client.session, pid: ctx.pid, window_id: ctx.wid, x: m.png[0], y: m.png[1], delivery_mode: 'foreground' });
  return true;
}
async function wheel(ctx, n = 1, dir = 'down', gap = [90, 260]) {
  await ctx.client.call('scroll', { pid: ctx.pid, window_id: ctx.wid, direction: dir, by: 'line', amount: n, delivery_mode: 'foreground' });
  await sleep(rnd(...gap));
}
// 阅读式滚动 targetPx（burst 3~6 格 + 阅读停顿 + 回看/漂移），返回实际推进像素
async function readScrollPx(ctx, tabId, targetPx) {
  const y0 = (await evalOn(tabId, 'return { y: Math.round(scrollY) }')).y;
  let y = y0, t0 = Date.now(), ticks = 0;
  while (y - y0 < targetPx && Date.now() - t0 < 90000) {
    const burst = 3 + Math.floor(Math.random() * 4);
    for (let k = 0; k < burst; k++) { await wheel(ctx, 1); ticks++; }
    await sleep(rnd(1500, 4300));
    if (Math.random() < 0.18) await wheel(ctx, 1, 'up', [500, 1100]);
    const p = await ctx.client.getPos();
    if (p && Math.random() < 0.3) await ctx.client.call('move_cursor', { session: ctx.client.session, scope: 'desktop', x: p[0] + Math.round((Math.random() - 0.5) * 90), y: p[1] + Math.round((Math.random() - 0.5) * 60) });
    y = (await evalOn(tabId, 'return { y: Math.round(scrollY) }')).y;
  }
  return { px: y - y0, ticks, sec: Math.round((Date.now() - t0) / 1000) };
}

// ═══════════ 意图动词 ═══════════
const verbs = {
  // 打开列表第 nth 个商品；效果=新标签(_blank)或本页跳转，两种都验证，首触学习 open 模式入库
  async open_item(ctx, a) {
    const nth = a.nth != null ? a.nth : ctx.cardCursor++;
    ctx.cardCursor = nth + 1;
    if (!(await ensureFront(ctx, ctx.listTab, a.titleRe || '.'))) throw new Error('前台校验失败');
    const snap = await snapshot(ctx.listTab, ctx.cache);
    const card = snap.cards[nth];
    if (!card) return { ok: false, note: `卡片#${nth} 不在视口（快照 ${snap.nCards} 个）` };
    const before = await ctx.listTabs();
    const prevUrl = snap.url;
    const g = await geom(ctx);
    if (!(await glideClick(ctx, g, card.vx, card.vy))) return { ok: false, note: '坐标无效' };
    const wantNew = (ctx.cache.cards && ctx.cache.cards.open) !== 'same_tab';
    // 新标签判定：同源任意新标签（通用）；缓存可覆写 tab_url_pattern
    const origin = new URL(snap.url).origin;
    const pat = (ctx.cache.cards && ctx.cache.cards.tab_url_pattern) || null;
    let detail = null, url = null;
    if (wantNew) {
      const t0 = Date.now();
      while (Date.now() - t0 < 12000 && !detail) {
        const nu = (await ctx.listTabs()).filter((t) => !before.some((b) => String(b.id) === String(t.id)));
        const hit = pat ? nu.find((t) => new RegExp(pat).test(t.url || '')) : nu.find((t) => (t.url || '').startsWith(origin));
        if (hit) detail = hit; else await sleep(700);
      }
    }
    if (!detail) url = await waitUrlChange(() => evalOn(ctx.listTab, 'return { u: location.href }').then((d) => d.u), prevUrl, 8000);
    if (!detail && !url) return { ok: false, note: '点击未见效果（无新标签、无跳转）' };
    if (detail && !(ctx.cache.cards && ctx.cache.cards.open)) ctx.learn({ cards: { ...ctx.cache.cards, open: 'new_tab' } });
    if (!detail && url && !(ctx.cache.cards && ctx.cache.cards.open)) ctx.learn({ cards: { ...ctx.cache.cards, open: 'same_tab' } });
    if (detail) ctx.focusTab = detail.id;
    return { ok: true, detailTab: detail && detail.id, url, cardId: card.id };
  },

  // 阅读式滚动 px（人味本体，不可压缩）
  async read_scroll(ctx, a) {
    const r = await readScrollPx(ctx, ctx.focusTab, a.px || 2200);
    return { ok: true, ...r };
  },

  // 滚到命名区块：分段阅读滚动 + 停滞熔断；效果=标记 docY 在视口带内
  async goto_section(ctx, a) {
    const sc = ctx.cache.scroll || {};
    const stallPx = sc.stall_px != null ? sc.stall_px : 150;
    const [c0, c1] = sc.chunk_px || [1700, 2600];
    let snap = await snapshot(ctx.focusTab, ctx.cache), stalls = 0, lastY = snap.scrollY, sec = 0;
    while (!(snap.sections && snap.sections[a.section]) && stalls < 2) {
      const r = await readScrollPx(ctx, ctx.focusTab, Math.round(rnd(c0, c1)));
      sec += r.sec;
      const y = (await evalOn(ctx.focusTab, 'return { y: Math.round(scrollY) }')).y;
      if (y - lastY < stallPx) stalls++; else stalls = 0;
      lastY = y;
      snap = await snapshot(ctx.focusTab, ctx.cache);
    }
    const hit = snap.sections && snap.sections[a.section];
    if (!hit) return { ok: false, note: `未找到区块 "${a.section}"（停滞熔断）`, sec };
    await evalOn(ctx.focusTab, `window.scrollTo(0, ${Math.max(0, hit.docY - 200)}); return { y: 1 }`);
    await sleep(rnd(1200, 2600));
    return { ok: true, marker: hit.text, docY: hit.docY, sec };
  },

  // 点击并验证：区块图（滚动后现测坐标 + 视口边界），预期=大图浮层
  async click_verified(ctx, a) {
    if (a.kind !== 'section_image') return { ok: false, note: `未知 kind ${a.kind}` };
    const sec = ctx.cache.sections && ctx.cache.sections[a.section];
    const snap = await snapshot(ctx.focusTab, ctx.cache);
    const hit = snap.sections && snap.sections[a.section];
    if (!hit) return { ok: false, note: '区块标记不可见，先 goto_section' };
    const imgs = await sectionImages(ctx.focusTab, { ...sec.images_band, docY: hit.docY });
    const img = imgs.imgs && imgs.imgs[Math.floor(Math.random() * imgs.imgs.length)];
    if (!img) return { ok: false, note: `区块 "${a.section}" 无可见图（${imgs.n}）` };
    if (img.vy < 40 || img.vy > snap.vh - 40) return { ok: false, note: `图在视口外 vy=${img.vy}` };
    if (!(await ensureFront(ctx, ctx.focusTab, a.titleRe || '.'))) throw new Error('前台校验失败');
    const g = await geom(ctx);
    if (!(await glideClick(ctx, g, img.vx, img.vy))) return { ok: false, note: '坐标无效' };
    await sleep(rnd(1300, 2500));
    const eff = await evalOn(ctx.focusTab, OVERLAY);
    return { ok: true, effect: eff.big ? 'overlay' : 'unverified', note: eff.big ? '' : '未见大图浮层（可能直接跳转或无浮层）' };
  },

  async press_key(ctx, a) {
    await ctx.client.call('press_key', { pid: ctx.pid, window_id: ctx.wid, key: a.key, delivery_mode: 'foreground' });
    await sleep(rnd(600, 1400));
    return { ok: true };
  },

  async close_tab(ctx, a) {
    const t = (a && a.tab) || ctx.focusTab;
    if (t && t !== ctx.listTab) await ctx.bridge('close_tab', { tabId: t }).catch(() => {});
    ctx.focusTab = ctx.listTab;
    return { ok: true };
  },

  async wait(ctx, a) { await sleep(a.ms || 2000); return { ok: true }; },
};

module.exports = { verbs, geom, mapV, ensureFront, readScrollPx };
