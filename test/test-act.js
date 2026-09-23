// test/test-act.js — act 层纯逻辑单测：效果 diff / 站点缓存分层 / 演练静态裁决
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { diffTabs } = require('../hands/act/effects');
const { checkPlan } = require('../hands/act/rehearse');
const siteCache = require('../hands/act/site_cache');

let n = 0;
const ok = (m) => { n++; console.log('  ✅ ' + m); };

// ── effects.diffTabs ──
{
  const before = [{ id: 1, url: 'https://a.com/x' }, { id: 2, url: 'https://a.com/y' }];
  const after = [...before, { id: 3, url: 'https://a.com/goods-g-123.html' }];
  const nu = diffTabs(before, after, '-g-');
  assert.strictEqual(nu.length, 1); assert.strictEqual(nu[0].id, 3);
  assert.strictEqual(diffTabs(before, after, 'nomatch').length, 0);
  assert.strictEqual(diffTabs(before, before).length, 0);
  ok('diffTabs 新标签识别 + url 模式过滤');
}

// ── site_cache 种子/用户分层 ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'act-sites-'));
  process.env.SCRADER_CONFIG_DIR = tmp;
  const c0 = siteCache.load('www.temu.com');
  assert.strictEqual(c0.cards.open, 'new_tab');          // 种子层
  assert.ok(c0.sections.reviews.patterns.length > 0);
  siteCache.save('www.temu.com', { cards: { ...c0.cards, open: 'same_tab' } }); // 用户层覆盖
  const c1 = siteCache.load('www.temu.com');
  assert.strictEqual(c1.cards.open, 'same_tab');
  assert.strictEqual(c1.sections.reviews.patterns.length, c0.sections.reviews.patterns.length); // 种子字段仍在
  assert.ok(fs.existsSync(siteCache.userPath('www.temu.com')));
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.SCRADER_CONFIG_DIR;
  ok('site_cache 种子合并 + 用户层覆盖 + 落盘路径');
}

// ── rehearse.checkPlan ──
{
  const cache = {
    cards: { selector: 'a[href*="-g-"]', open: 'new_tab' },
    sections: { reviews: { patterns: ['[0-9]+[ ]*条评价'] } },
  };
  const snap = { nCards: 3, cards: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }], sections: {}, vh: 900 };
  // 全绿：卡片 + 懒加载区块 + 区块图
  const r1 = checkPlan(snap, { steps: [
    { verb: 'open_item', args: { nth: 1 } },
    { verb: 'goto_section', args: { section: 'reviews' } },
    { verb: 'click_verified', args: { kind: 'section_image', section: 'reviews' } },
    { verb: 'press_key', args: { key: 'ESCAPE' } },
    { verb: 'close_tab', args: {} },
  ] }, cache);
  assert.ok(r1.pass); assert.strictEqual(r1.lazy.length, 2); // goto_section + click_verified 需现场探测
  ok('checkPlan 合法计划 pass + lazy 标记');
  // 卡片越界
  const r2 = checkPlan(snap, { steps: [{ verb: 'open_item', args: { nth: 5 } }] }, cache);
  assert.ok(!r2.pass); assert.ok(/超出/.test(r2.steps[0].note));
  ok('checkPlan 卡片越界拦截');
  // 未知区块（缓存无标记模式 → 必须先探察入库）
  const r3 = checkPlan(snap, { steps: [{ verb: 'goto_section', args: { section: 'qa' } }] }, cache);
  assert.ok(!r3.pass);
  ok('checkPlan 未知区块拦截（先探察后入库）');
  // 标记已见的区块（快照直接命中）
  const r4 = checkPlan({ ...snap, sections: { reviews: { docY: 800, text: '35条评价' } } }, { steps: [{ verb: 'goto_section', args: { section: 'reviews' } }] }, cache);
  assert.ok(r4.pass); assert.ok(/已见/.test(r4.steps[0].note));
  ok('checkPlan 标记已见路径');
  // 未知动词
  assert.ok(!checkPlan(snap, { steps: [{ verb: 'fly' }] }, cache).pass);
  ok('checkPlan 未知动词拦截');
}

console.log(`✅ act 层纯逻辑 ${n} 组断言全部通过`);
