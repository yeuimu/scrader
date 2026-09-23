// hands/act/grounding.js — 意图→定位：站点缓存 → DOM 启发式 → UIA（视觉为后续兜底）
// 快照 = 一次 evaluate 拿全页事实；演练与执行共用同一解析器，演练通过 ≈ 执行可解析
'use strict';
const { callBridge } = require('../../core/lib/router');

function evalOn(tabId, code) {
  return callBridge('evaluate', { tabId, code }, 120000).then((r) => {
    if (r && r.json && r.json.ok === false) throw new Error('page error: ' + r.json.error);
    return r && r.json && r.json.data;
  });
}

// 页面快照：视口内卡片（id+点击点）、命名区块标记（docY）、几何。cache 提供选择器/标记模式
const SNAP = (cache) => `
return (() => {
  const zw = /[\\u200b-\\u200d\\u2060\\ufeff]/g;
  const cardSel = ${JSON.stringify((cache.cards && cache.cards.selector) || 'a[href]')};
  const idRe = ${JSON.stringify((cache.cards && cache.cards.id_from_href) || null)};
  const marks = ${JSON.stringify(Object.entries(cache.sections || {}).map(([k, v]) => [k, v.patterns]))};
  const cards = [];
  const seen = new Set();
  for (const a of document.querySelectorAll(cardSel)) {
    const r = a.getBoundingClientRect();
    if (r.width < 60 || r.top < 40 || r.top > innerHeight - 40) continue;
    const href = a.href || '';
    let id = href;
    if (idRe) { const m = href.match(new RegExp(idRe)); if (m) id = m[1]; else continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const img = a.querySelector('img') || a;
    const ir = img.getBoundingClientRect();
    cards.push({ id, vx: Math.round(ir.left + ir.width / 2), vy: Math.round(ir.top + Math.min(ir.height / 2, 220)) });
  }
  const sections = {};
  for (const [name, pats] of marks) {
    let hit = null;
    for (const el of document.querySelectorAll('h1,h2,h3,div,span,button,a')) {
      const t = ((el.textContent || '') + '').replace(zw, '').trim();
      if (!t || t.length > 40) continue;
      if (pats.some((p) => new RegExp(p).test(t))) {
        const r = el.getBoundingClientRect();
        if (r.width > 40) { hit = { docY: Math.round(r.top + scrollY), text: t.slice(0, 24) }; break; }
      }
    }
    if (hit) sections[name] = hit;
  }
  return { url: location.href, scrollY: Math.round(scrollY), vh: innerHeight, vw: innerWidth,
    docH: Math.round(document.documentElement.scrollHeight), nCards: cards.length, cards: cards.slice(0, 24), sections };
})()`;

async function snapshot(tabId, cache) { return evalOn(tabId, SNAP(cache || {})); }

// 区块内图片：标记下方垂直带 + 尺寸窗（解耦 DOM 嵌套，travel v4 验证过的扫法）
const SECTION_IMGS = (band) => `
return (() => {
  const docY = ${Math.round(band.docY)};
  const below = ${Math.round(band.below || 2600)}, mn = ${Math.round((band.size || [55, 420])[0])}, mx = ${Math.round((band.size || [55, 420])[1])};
  const out = [];
  for (const im of document.querySelectorAll('img')) {
    const b = im.getBoundingClientRect();
    const dy = b.top + scrollY;
    if (dy > docY - 120 && dy < docY + below && b.width >= mn && b.height >= mn && b.width <= mx && b.height <= mx)
      out.push({ vx: Math.round(b.left + b.width / 2), vy: Math.round(b.top + b.height / 2) });
  }
  return { n: out.length, imgs: out };
})()`;

async function sectionImages(tabId, band) { return evalOn(tabId, SECTION_IMGS(band)); }

// 大图浮层是否可见（点击评论图后的效果证据）
const OVERLAY = `
return { big: [...document.querySelectorAll('img')].some((im) => { const b = im.getBoundingClientRect(); return b.width > innerWidth * 0.5 && b.height > innerHeight * 0.4; }) }`;

module.exports = { evalOn, snapshot, sectionImages, OVERLAY };
