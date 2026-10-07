#!/usr/bin/env node
// hands/act/guard.js — 站点守卫 CLI：采集前的检查单 + 封锁处置 + 温启
// 用法:
//   node hands/act/guard.js --tab T --check              检测当前页封锁态（hard/soft/ok）
//   node hands/act/guard.js --host H --gate --n 200      限额闸门（blocked/daily_cap）
//   node hands/act/guard.js --tab T --host H --warmup    温启序列（首页种 cookie → 轻浏览）
//   node hands/act/guard.js --host H --block 30          记录封锁，冷却 30 分钟
//   node hands/act/guard.js --host H --collected 200     回写今日采集量
//   node hands/act/guard.js --host H --unblock           解除冷却（确认恢复后）
'use strict';
const { callBridge } = require('../../core/lib/router');
const siteCache = require('./site_cache');
const guard = require('./site_guard');

const args = (() => { const o = {}; const a = process.argv.slice(2); for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1]; return o; })();
const has = (k) => k in args;
const TAB = +args.tab;
const nav = (tabId, url) => callBridge('navigate', { tabId, url }, 60000);

(async () => {
  if (has('check')) {
    const tab = TAB || (await callBridge('list_tabs', {}, 30000).then((r) => { const j = r && r.json; const d = j && (j.data ?? j); return (Array.isArray(d) ? d : []).find((t) => /temu|search_result|-g-/.test(t.url || '')); })).id;
    const host = args.host || 'www.temu.com';
    const r = await guard.check(tab, siteCache.load(host));
    console.log(JSON.stringify(r, null, 1));
    if (!r.ok && r.signal === 'hard_block') guard.recordBlock(host, (guard.guardFor(host, siteCache.load(host)).limits || {}).block_cooldown_min || 20);
    process.exit(r.ok ? 0 : 2);
  }
  if (has('gate')) {
    const host = args.host;
    const r = guard.gate(host, siteCache.load(host));
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 3);
  }
  if (has('warmup')) {
    const host = args.host || 'www.temu.com';
    const steps = await guard.warmup(TAB, host, nav);
    console.log(JSON.stringify({ ok: true, steps }, null, 1));
    process.exit(0);
  }
  if (has('block')) { const until = guard.recordBlock(args.host, +args.block || 20); console.log('blocked until', new Date(until).toLocaleString()); process.exit(0); }
  if (has('collected')) { const c = guard.recordCollect(args.host, +args.collected); console.log('今日累计', c); process.exit(0); }
  if (has('unblock')) { guard.clearBlock(args.host); console.log('cooldown cleared'); process.exit(0); }
  console.error('用法见文件头注释');
  process.exit(1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
