#!/usr/bin/env node
// hands/act/act.js — 意图动词层 CLI：快照 → 演练（快介质）→ 闭环执行（慢介质，每步效果证据）
// 用法: node hands/act/act.js --plan plan.json --tab <listTabId> --pid P --wid W [--exec] [--title-re Temu]
//   plan.json: {"steps":[{"verb":"open_item","args":{"nth":0}}, ...]}
// 不带 --exec 只演练（零输入事件零风控暴露）；带 --exec 才真实操作。
'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('../cua/client');
const { callBridge } = require('../../core/lib/router');
const { snapshot } = require('./grounding');
const { checkPlan } = require('./rehearse');
const { verbs } = require('./verbs');
const siteCache = require('./site_cache');

const args = (() => { const o = {}; const a = process.argv.slice(2); for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1]; return o; })();
const TAB = +args.tab, PID = +args.pid, WID = +args.wid, EXEC = 'exec' in args;
if (!TAB || !PID || !WID || !args.plan) { console.error('用法: node act.js --plan p.json --tab T --pid P --wid W [--exec]'); process.exit(1); }

const bridge = (tool, a, t) => callBridge(tool, a, t || 30000);
const listTabs = () => bridge('list_tabs').then((r) => { const j = r && r.json; const d = j && (j.data ?? j); return Array.isArray(d) ? d : []; });

(async () => {
  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
  const snap0 = await snapshot(TAB, {});
  const host = new URL(snap0.url).host || 'file.local';
  const cache = siteCache.load(host);
  console.log(`host=${host} 缓存: cards.open=${(cache.cards && cache.cards.open) || '未知(将学习)'} sections=${Object.keys(cache.sections || {}).join('/') || '无'}`);

  // ── 演练（快介质）：带缓存的完整快照 + 静态裁决 ──
  const snap = await snapshot(TAB, cache);
  const re = checkPlan(snap, plan, cache);
  console.log('==rehearsal== ' + JSON.stringify(re));
  if (!re.pass || !EXEC) process.exit(re.pass ? 0 : 2);

  // ── 执行（慢介质）：意图动词闭环 ──
  const client = createClient({ session: 'act-' + host, clientName: 'act' });
  await client.init();
  const ctx = {
    client, pid: PID, wid: WID, bridge, listTabs, listTab: TAB, focusTab: TAB, cache, cardCursor: 0,
    learn: (patch) => { Object.assign(cache, patch); siteCache.save(host, patch); console.log('  [cache] 学习入库: ' + JSON.stringify(patch).slice(0, 120)); },
  };
  const t0 = Date.now(); const results = [];
  for (const st of plan.steps) {
    const v = verbs[st.verb];
    if (!v) { results.push({ verb: st.verb, ok: false, note: '未知动词' }); break; }
    try {
      const r = await v(ctx, st.args || {});
      results.push({ verb: st.verb, ...r });
      console.log(`  ${r.ok ? '✓' : '⚠'} ${st.verb} ${JSON.stringify(r).slice(0, 160)}`);
      if (!r.ok && st.must !== false) break; // 闭环：未验证即停，不盲走下一步
    } catch (e) {
      results.push({ verb: st.verb, ok: false, note: e.message.slice(0, 120) });
      console.log(`  ✗ ${st.verb} ${e.message.slice(0, 120)}`);
      break;
    }
  }
  await client.end().catch(() => {});
  console.log('==summary== ' + JSON.stringify({ host, steps: results.length, ok: results.filter((r) => r.ok).length, sec: Math.round((Date.now() - t0) / 1000), results }));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1); });
