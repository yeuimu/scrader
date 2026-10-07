// hands/act/site_guard.js — 站点守卫：封锁检测 + 温启 + 限额闸门（通用方案，站点签名来自 seeds/用户缓存）
// 背景：新机器/新 agent 直接深链列表页开抓是最高风控权重姿势；封锁后重试轰炸会延长封锁。
// 本模块把"采集前检查单"和"封锁处置协议"固化成代码，任何 agent（ZCode/pi/…）装了 scrader 都自动继承。
'use strict';
const { evalOn } = require('./grounding');
const siteCache = require('./site_cache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

// 内置默认（temu 实测签名）；种子/用户缓存里 guard 节可覆盖或新增站点
const DEFAULT_GUARD = {
  block_urls: ['bgn_no_access.html', '/bgn_verification', 'captcha', 'verify human'],
  soft_titles: ['no internet connection'], // Temu SW 离线墙：可能是封锁也可能是真断网，需 curl 对照
  warmup: [
    { nav: 'https://www.temu.com/', wait: '#searchInput', dwell: [4000, 8000] },
    { scroll: 1400, dwell: [2500, 5000] },
  ],
  limits: { daily_cap_items: 800, batch_cooldown_s: [45, 120], max_items_per_run: 300, block_cooldown_min: 20 },
};

function guardFor(host, cache) {
  return { ...DEFAULT_GUARD, ...(cache.guard || {}) };
}

// ── 检测：页面是否处于封锁/异常态 ──
// 返回 { ok, signal: null|'hard_block'|'soft_offline'|'not_target', detail }
async function check(tabId, cache = {}) {
  const g = guardFor(cache.host, cache);
  const probe = await evalOn(tabId, `
    return { url: location.href, title: (document.title || '').toLowerCase(),
      body: ((document.body && document.body.innerText) || '').slice(0, 300).toLowerCase(),
      cards: document.querySelectorAll('a[href*="-g-"]').length };
  `);
  const url = probe.url || '';
  for (const sig of g.block_urls || []) {
    if (url.includes(sig)) return { ok: false, signal: 'hard_block', detail: 'URL 命中封锁签名: ' + sig + ' —— 立即停止一切该站请求，冷却 ' + (g.limits.block_cooldown_min) + ' 分钟以上，恢复后先温启' };
  }
  for (const t of g.soft_titles || []) {
    if ((probe.title || '').includes(t)) return { ok: false, signal: 'soft_offline', detail: 'SW 离线墙（"' + t + '"）—— 可能是真断网/代理抖动也可能是封锁：先 curl 同 URL 对照，curl 通 = 浏览器侧问题，curl 不通 = 链路问题，都不是才按封锁处理' };
  }
  if (!probe.cards && /search_result|-[0-9]{10,}\.html/.test(url)) {
    return { ok: false, signal: 'not_target', detail: '在列表/详情 URL 上但 0 商品卡 —— 页面未渲染完成或被软拒，等待 10s 重探一次，仍为 0 视同 hard_block' };
  }
  return { ok: true, signal: null, detail: probe.cards + ' cards', probe };
}

// ── 限额闸门：blocked_until 未过 / 单日超 cap → 拒绝 ──
function gate(host, cache) {
  const g = guardFor(host, cache);
  const st = cache.state || {};
  const now = Date.now();
  if (st.blocked_until && now < st.blocked_until) {
    const min = Math.ceil((st.blocked_until - now) / 60000);
    return { ok: false, why: 'cooldown', detail: `该站处于封锁冷却期（还剩 ${min} 分钟）。期间零请求；到期后先 guard 温启再轻量试水（≤40 条）` };
  }
  const today = new Date().toISOString().slice(0, 10);
  const cnt = (st.daily || {}).date === today ? (st.daily.count || 0) : 0;
  if (cnt >= g.limits.daily_cap_items) {
    return { ok: false, why: 'daily_cap', detail: `今日已采 ${cnt} 条 ≥ 上限 ${g.limits.daily_cap_items}。明天再采，贪量是最常见的封号原因` };
  }
  return { ok: true, detail: `今日已采 ${cnt}/${g.limits.daily_cap_items}` };
}

// ── 状态回写 ──
function recordBlock(host, minutes) {
  const cache = siteCache.load(host);
  const until = Date.now() + Math.max(1, minutes) * 60000;
  siteCache.save(host, { state: { ...(cache.state || {}), blocked_until: until, last_signal: new Date().toISOString() } });
  return until;
}
function recordCollect(host, n) {
  const cache = siteCache.load(host);
  const today = new Date().toISOString().slice(0, 10);
  const d = (cache.state || {}).daily || {};
  const count = (d.date === today ? d.count || 0 : 0) + n;
  siteCache.save(host, { state: { ...(cache.state || {}), daily: { date: today, count } } });
  return count;
}
function clearBlock(host) {
  const cache = siteCache.load(host);
  siteCache.save(host, { state: { ...(cache.state || {}), blocked_until: 0 } });
}

// ── 温启：首页种 cookie → 停留 → 轻浏览 →（调用方随后再进目标页）──
// nav(tabId, url) 由调用方注入（bridge navigate）；每步 dwell 拟人抖动
async function warmup(tabId, host, nav) {
  const cache = siteCache.load(host);
  const g = guardFor(host, cache);
  const steps = [];
  for (const st of g.warmup || []) {
    if (st.nav) {
      await nav(tabId, st.nav);
      if (st.wait) await pollFor(tabId, st.wait, 25000);
      const d = Math.round(rnd(...(st.dwell || [3000, 7000])));
      await sleep(d);
      steps.push(`nav ${st.nav} + dwell ${d}ms`);
    } else if (st.scroll) {
      await evalOn(tabId, `window.scrollTo(0, ${st.scroll}); return { y: Math.round(scrollY) }`);
      const d = Math.round(rnd(...(st.dwell || [2000, 4000])));
      await sleep(d);
      steps.push(`scroll ${st.scroll} + dwell ${d}ms`);
    }
  }
  return steps;
}

async function pollFor(tabId, selector, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalOn(tabId, `return { found: !!document.querySelector(${JSON.stringify(selector)}) }`);
    if (r.found) return true;
    await sleep(800);
  }
  return false;
}

module.exports = { check, gate, warmup, recordBlock, recordCollect, clearBlock, guardFor, DEFAULT_GUARD };
