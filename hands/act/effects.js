// hands/act/effects.js — 效果证据：每个动作带回执，未验证不宣称成功（闭环控制核心）
// 纯函数与 IO 分离：diff* 可单测；wait* 是慢介质上的轮询等待
'use strict';

// ---- 纯函数 ----
// 新标签 diff：after 中不在 before 里的、且 url 命中模式的第一个
function diffTabs(before, after, urlPattern) {
  const b = new Set(before.map((t) => String(t.id)));
  const nu = after.filter((t) => !b.has(String(t.id)));
  const re = urlPattern ? new RegExp(urlPattern) : null;
  return re ? nu.filter((t) => re.test(t.url || '')) : nu;
}

// ---- IO（慢介质）----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTab(listTabs, before, urlPattern, timeoutMs = 12000, pollMs = 700) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const nu = diffTabs(before, await listTabs(), urlPattern);
    if (nu.length) return nu[0];
    await sleep(pollMs);
  }
  return null;
}

async function waitUrlChange(getUrl, prevUrl, timeoutMs = 8000, pollMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const u = await getUrl();
    if (u && u !== prevUrl && !/^about:/.test(u)) return u;
    await sleep(pollMs);
  }
  return null;
}

module.exports = { diffTabs, waitTab, waitUrlChange };
