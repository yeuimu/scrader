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


// ── site_guard：限额闸门 + 封锁回写（纯逻辑，临时配置目录）──
{
  process.env.SCRADER_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'act-guard-'));
  const guard = require('../hands/act/site_guard');
  const host = 'www.temu.com';
  // 未封锁未超限 → 放行
  const g1 = guard.gate(host, guard.guardFor(host, {}));
  assert.ok(g1.ok, 'fresh host should pass gate');
  // 记封锁 → 闸门拒绝且给冷却指引
  guard.recordBlock(host, 20);
  const g2 = guard.gate(host, siteCache.load(host));
  assert.ok(!g2.ok && g2.why === 'cooldown');
  // 解除 → 放行；采集计数累加，超日限拒绝
  guard.clearBlock(host);
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../hands/act/seeds/www.temu.com.json'), 'utf8'));
  const cap = seed.guard.limits.daily_cap_items;
  guard.recordCollect(host, cap - 10);
  guard.recordCollect(host, 10);
  const g3 = guard.gate(host, siteCache.load(host));
  assert.ok(!g3.ok && g3.why === 'daily_cap', 'daily cap should trip at ' + cap);
  // guardFor 种子合并：limits 来自种子，warmup 可被用户层覆盖
  const gf = guard.guardFor(host, siteCache.load(host));
  assert.strictEqual(gf.limits.daily_cap_items, cap);
  assert.ok(gf.warmup.length > 0);
  assert.ok(gf.block_urls.includes('bgn_no_access.html'));
  fs.rmSync(process.env.SCRADER_CONFIG_DIR, { recursive: true, force: true });
  delete process.env.SCRADER_CONFIG_DIR;
  ok('site_guard 闸门/封锁回写/日限/种子合并');
}


// ── collect 纯函数：验收 + 限额裁剪 ──
{
  const { validateItems, clampTarget } = require('../hands/act/collect');
  // 无法直接 require CLI？——collect.js 是脚本不是模块：把纯函数提出校验前先探测导出
  const v1 = validateItems([{ stableId: 'a', anchorText: 't', price: 1, image: 'i' }, { stableId: 'b', anchorText: 't2', price: 2, image: 'i2' }]);
  assert.ok(v1.pass && v1.total === 2 && v1.uniqueIds === 2);
  const v2 = validateItems([{ stableId: 'a', anchorText: 't', price: 1, image: 'i' }, { stableId: 'a', anchorText: 't2', price: null, image: 'i2' }]);
  assert.ok(!v2.pass && v2.uniqueIds === 1 && v2.missing.price === 1, '重复 ID + 缺价必须判废');
  assert.ok(!validateItems([]).pass, '空结果不通过');
  const c1 = clampTarget(200, 300, 800);
  assert.strictEqual(c1.target, 300); assert.ok(!c1.clamped);
  const c2 = clampTarget(750, 300, 800);
  assert.strictEqual(c2.target, 50); assert.ok(c2.clamped, '剩余不足必须裁剪不超限');
  const c3 = clampTarget(800, 300, 800);
  assert.strictEqual(c3.target, 0);
  ok('collect validateItems/clampTarget（验收与限额裁剪）');
}

console.log(`✅ act 层纯逻辑 ${n} 组断言全部通过`);
