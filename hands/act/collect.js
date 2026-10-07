#!/usr/bin/env node
// hands/act/collect.js — 采集动词：六步协议一次调用代码强制（闸门→检查→温启→采集→验收→记账）
// 设计原则：协议不靠 agent 自觉——闸门不过不采、封锁签名即停、未温启先温启、验收不达标报警、记账必回写。
// 用法: node hands/act/collect.js --tab T --pid P --wid W --target N --out f.json [--host auto] [--force-warmup] [--maxsec 900]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { callBridge } = require('../../core/lib/router');
const siteCache = require('./site_cache');
const guard = require('./site_guard');

const REPO = path.resolve(__dirname, '..', '..');
const log = (m) => console.log('[collect] ' + m);
const evalOn = (tabId, code) => callBridge('evaluate', { tabId, code }, 120000).then((r) => {
  if (r && r.json && r.json.ok === false) throw new Error('page error: ' + r.json.error);
  return r && r.json && r.json.data;
});

// ---- 纯函数（单测覆盖）----
// 验收：唯一 ID、关键字段缺失（部分站点天然无已售，只查 title/price/image 三硬字段）
function validateItems(items) {
  const arr = items || [];
  const ids = new Set(arr.map((x) => x.stableId));
  const miss = { title: 0, price: 0, image: 0 };
  arr.forEach((x) => { miss.title += !x.anchorText; miss.price += x.price == null; miss.image += !x.image; });
  const bad = ids.size !== arr.length || miss.title || miss.price || miss.image;
  return { total: arr.length, uniqueIds: ids.size, missing: miss, pass: !bad && arr.length > 0 };
}
// 限额裁剪：今日剩余不足时把目标压到剩余量（不悄悄超限）
function clampTarget(collectedToday, target, dailyCap) {
  const remaining = Math.max(0, dailyCap - collectedToday);
  return { target: Math.min(target, remaining), remaining, clamped: remaining < target };
}

function main() {
  const args = (() => { const o = {}; const a = process.argv.slice(2); for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1]; return o; })();
  const TAB = +args.tab, PID = +args.pid, WID = +args.wid, TARGET = +args.target;
  const OUT = args.out, MAXSEC = +(args.maxsec || 900), FORCE_WARMUP = 'force-warmup' in args;
  if (!TAB || !PID || !WID || !TARGET || !OUT) {
    console.error('用法: node hands/act/collect.js --tab T --pid P --wid W --target N --out f.json [--force-warmup] [--maxsec 900]');
    process.exit(1);
  }

  (async () => {
    // ── 0) 站点识别 ──
    const url = await evalOn(TAB, 'return { u: location.href }').then((d) => d.u);
    const host = args.host && args.host !== 'auto' ? args.host : (new URL(url).host || 'file.local');
    const cache = siteCache.load(host);
    log(`host=${host} target=${TARGET}`);

    // ── 1) 闸门：封锁冷却 / 日限 ──
    const g = guard.gate(host, cache);
    log('gate: ' + JSON.stringify(g));
    if (!g.ok) { console.error('⛔ ' + g.detail); process.exit(3); }

    // ── 2) 检查：封锁签名（硬封锁即记账退出）──
    const chk = await guard.check(TAB, cache);
    log('check: ' + JSON.stringify({ ok: chk.ok, signal: chk.signal, detail: (chk.detail || '').slice(0, 80) }));
    if (!chk.ok && chk.signal === 'hard_block') {
      guard.recordBlock(host, guard.guardFor(host, cache).limits.block_cooldown_min || 20);
      console.error('⛔ ' + chk.detail); process.exit(2);
    }
    if (!chk.ok && chk.signal === 'soft_offline') { console.error('⛔ ' + chk.detail); process.exit(4); }

    // ── 3) 温启：目标页无卡（新会话/恢复后/深链冷启）或显式要求时执行 ──
    const warm = chk.probe && chk.probe.cards > 0;
    if (!warm || FORCE_WARMUP) {
      const steps = await guard.warmup(TAB, host, (t, u) => callBridge('navigate', { tabId: t, url: u }, 60000));
      log('warmup: ' + JSON.stringify(steps));
      const re = await guard.check(TAB, cache); // 温启走了首页；调用方随后需回目标页或站内搜索
      if (!re.ok) { console.error('⛔ 温启后仍异常: ' + re.detail); process.exit(2); }
      if (!warm) { console.error('⛔ 目标页 0 卡且温启后仍未就绪——请先导航回目标列表页再跑 collect'); process.exit(2); }
    } else log('warmup: 跳过（目标页已热，' + chk.probe.cards + ' 卡在视口）');

    // ── 4) 限额裁剪 ──
    const st = siteCache.load(host).state || {};
    const today = new Date().toISOString().slice(0, 10);
    const collectedToday = (st.daily || {}).date === today ? (st.daily.count || 0) : 0;
    const cl = clampTarget(collectedToday, TARGET, guard.guardFor(host, cache).limits.daily_cap_items);
    if (cl.clamped) log(`今日剩余 ${cl.remaining}，目标裁剪 ${TARGET}→${cl.target}`);
    if (cl.target === 0) { console.error('⛔ 今日限额已用尽'); process.exit(3); }

    // ── 5) 采集：站点配方子进程（久经实战的滚采循环，单一事实源）──
    const recipe = path.join(REPO, 'recipes', host.replace(/^www\./, '').split('.')[0], 'accumulate_human.js');
    const recipePath = fs.existsSync(recipe) ? recipe : path.join(REPO, 'recipes', 'temu', 'accumulate_human.js');
    log(`recipe: ${path.relative(REPO, recipePath)} target=${cl.target}`);
    const before = fs.existsSync(OUT) ? (JSON.parse(fs.readFileSync(OUT, 'utf8')).items || []).length : 0;
    await new Promise((res, rej) => {
      const p = spawn(process.execPath, [recipePath, '--tab', String(TAB), '--target', String(cl.target), '--out', OUT, '--pid', String(PID), '--wid', String(WID), '--maxsec', String(MAXSEC)], { stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error('recipe exit ' + c))));
      p.on('error', rej);
    });

    // ── 6) 验收 + 记账 ──
    const items = fs.existsSync(OUT) ? (JSON.parse(fs.readFileSync(OUT, 'utf8')).items || []) : [];
    const v = validateItems(items);
    log('validate: ' + JSON.stringify(v));
    const added = Math.max(0, v.total - before);
    const todayCount = guard.recordCollect(host, added || v.total);
    log(`ledger: +${added || v.total}（before=${before}）→ 今日 ${todayCount}`);
    console.log('==summary== ' + JSON.stringify({ host, target: cl.target, ...v, added, out: OUT, pass: v.pass }));
    process.exit(v.pass ? 0 : 5);
  })().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}

module.exports = { validateItems, clampTarget };
if (require.main === module) main();
