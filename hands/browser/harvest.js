// hands/browser/harvest.js — 页面采集代码生成（DOM 感知的代码生成器，浏览器专属）
// 算法来自实战验证：小步滚动→逐步采集→按 stableId 合并取非空→慢速二遍补采→图片规范化
'use strict';

function genHarvestCode(a) {
  const p = {
    sel: String(a.itemSelector),
    max: Number(a.maxItems) || 0,
    levels: Number(a.cardLevels) || 4,
    stable: a.stableIdPattern ? String(a.stableIdPattern) : null,
    fields: (a.fields || []).map((f) => ({ key: String(f.key), pattern: String(f.pattern), kind: f.kind === 'int' ? 'int' : 'string' })),
  };
  return `
return (async () => {
  const SEL = ${JSON.stringify(p.sel)}, MAX = ${p.max}, LV = ${p.levels}, STABLE = ${JSON.stringify(p.stable)}, FIELDS = ${JSON.stringify(p.fields)};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const items = new Map(); let seq = 0;
  const collect = () => {
    for (const a of document.querySelectorAll(SEL)) {
      const href = a.href || '';
      const cleanHref = href.split('?')[0];
      const m0 = STABLE ? cleanHref.match(new RegExp(STABLE)) : (cleanHref.match(/\\d{4,}/g) || []);
      const id = STABLE ? (m0 ? m0[1] : cleanHref) : (m0.length ? m0[m0.length - 1] : cleanHref);
      let card = a; for (let i = 0; i < LV && card.parentElement; i++) card = card.parentElement;
      // 离屏未渲染的卡片 innerText 为空（文字渲染懒加载），textContent 不依赖渲染永远完整
      let rawTxt = (card.innerText || '') + '';
      if (!rawTxt.trim()) rawTxt = (card.textContent || '') + '';
      const cardText = rawTxt.replace(/\\n+/g, '|');
      let img = null, bestScore = -1;
      for (const im of card.querySelectorAll('img')) {
        const s = im.currentSrc || im.src || '';
        if (!/^https?:\\/\\//.test(s)) continue;
        const score = (im.naturalWidth || 0) + (im.naturalHeight || 0);
        if (score > bestScore) { bestScore = score; img = s.split('?')[0]; }
      }
      if (bestScore >= 0 && bestScore < 160) img = null; // 小图=角标/占位
      const cur = { stableId: id, href: cleanHref, anchorText: (((a.innerText || '') + '').trim() || ((a.textContent || '') + '').trim()).slice(0, 300), cardText: cardText.slice(0, 500), image: img };
      for (const f of FIELDS) {
        const m = cardText.match(new RegExp(f.pattern));
        cur[f.key] = m ? (f.kind === 'int' ? parseInt(m[1].replace(/,/g, ''), 10) : m[1]) : null;
      }
      if (!items.has(id)) { cur._seq = ++seq; items.set(id, cur); }
      else { const old = items.get(id); for (const k of Object.keys(cur)) if (old[k] == null && cur[k] != null) old[k] = cur[k]; }
    }
  };
  const t0 = Date.now();
  collect();
  window.scrollTo(0, 0); await wait(700); collect();
  let last = -1, stag = 0;
  for (let i = 0; i < 60; i++) {
    window.scrollBy(0, Math.round(innerHeight * 0.9));
    await wait(400 + Math.random() * 500); // 步进间隔抖动，避免等距节奏指纹
    collect();
    if (MAX && items.size >= MAX) { await wait(800); collect(); break; }
    const y = window.scrollY;
    if (Math.abs(y - last) < 2) { if (++stag >= 2) break; } else stag = 0;
    last = y;
  }
  // 二遍慢速补采：小步走完整页，空值数连续 3 步不降且已到底才停
  const nullCount = () => { let n = 0; for (const v of items.values()) { if (v.image == null) n++; for (const f of FIELDS) if (v[f.key] == null) n++; } return n; };
  let prevNull = -1, staleSteps = 0;
  window.scrollTo(0, 0); await wait(700); collect();
  for (let i = 0; i < 60; i++) {
    window.scrollBy(0, Math.round(innerHeight * 0.9));
    await wait(450 + Math.random() * 500);
    collect();
    const atEnd = window.scrollY + innerHeight >= document.documentElement.scrollHeight - 5;
    const nowNull = nullCount();
    if (nowNull === prevNull) staleSteps++; else staleSteps = 0;
    prevNull = nowNull;
    if (atEnd && staleSteps >= 3) break;
  }
  collect();
  window.scrollTo(0, 0);
  const list = [...items.values()].sort((x, y) => x._seq - y._seq).map(({ _seq, ...r }) => r);
  if (MAX && list.length > MAX) list.length = MAX; // 首遍 collect 会收走 DOM 现存全部卡片，按上限截断
  const stats = { count: list.length, elapsedMs: Date.now() - t0 };
  for (const f of FIELDS) stats['null_' + f.key] = list.filter((x) => x[f.key] == null).length;
  stats.null_image = list.filter((x) => !x.image).length;
  stats.uniqueImages = new Set(list.map((x) => x.image)).size;
  return { items: list, stats };
})();`;
}

module.exports = { genHarvestCode };
