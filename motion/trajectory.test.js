// motion/trajectory.test.js — 轨迹纯函数单测（不碰机器）：node motion/trajectory.test.js
'use strict';
const assert = require('assert');
const { CFG, buildWaypoints, buildTimeline } = require('./trajectory');

// 固定随机源（确定性断言）
const randNo = () => 0.99;   // 概率分支全落"否"
const randYes = () => 0.01;  // 概率分支全落"是"
const randHalf = () => 0.5;  // 弧向一侧、其余稳定

// ── buildWaypoints ──
const base = buildWaypoints(0, 0, 300, 0, { ...CFG, OVERSHOOT_PROB: 0 }, randNo);
assert.strictEqual(base.length, 20, '300px 应 20 航点');
assert.strictEqual(buildWaypoints(0, 0, 100, 0, { ...CFG, OVERSHOOT_PROB: 0 }, randNo).length, 8, '短距离最低 8 航点');
assert.strictEqual(buildWaypoints(0, 0, 1, 0).length, 1, '<2px 直接终点');
const last = base[base.length - 1];
assert.ok(Math.abs(last.x - 300) < 1e-6 && Math.abs(last.y) < 1e-6, '终点精确');
for (let i = 1; i < base.length; i++) assert.ok(base[i].eased >= base[i - 1].eased - 1e-9, `eased 单调 @${i}`);
const ov = buildWaypoints(0, 0, 300, 0, { ...CFG, OVERSHOOT_PROB: 1, OVERSHOOT_MIN_PX: 5, OVERSHOOT_MAX_PX: 5 }, randYes);
assert.strictEqual(ov.length, 22, '过冲 +2 航点');
assert.ok(ov[ov.length - 2].x > 300, '过冲沿行进方向越过目标');
assert.ok(Math.abs(ov[ov.length - 1].x - 300) < 1e-6, '终点回正');
const arcPts = buildWaypoints(0, 0, 300, 0, { ...CFG, OVERSHOOT_PROB: 0 }, randHalf);
assert.ok(Math.max(...arcPts.map((p) => Math.abs(p.y))) > 1, '贝塞尔弧线偏离直线');

// ── buildTimeline ──
const tl = buildTimeline(0, 0, 300, 0, { ...CFG, OVERSHOOT_PROB: 0, JITTER_PROB: 0 }, randNo);
assert.strictEqual(tl.steps.length, 20, 'timeline 航点数一致');
assert.ok(tl.dur >= CFG.DUR_MIN_MS && tl.dur <= CFG.DUR_MAX_MS * 1.6, '时长落在 [DUR_MIN, DUR_MAX×1.6]：' + tl.dur);
for (let i = 1; i < tl.steps.length; i++) assert.ok(tl.steps[i].tMs > tl.steps[i - 1].tMs, `tMs 严格递增 @${i}`);
assert.strictEqual(tl.steps[tl.steps.length - 1].x, 300, 'timeline 终点 X 精确（微颤不污染末格）');
assert.strictEqual(tl.steps[tl.steps.length - 1].y, 0, 'timeline 终点 Y 精确');
// 首尾慢、中间快（sin 减速因子）：首 3 步平均步距 > 中间 3 步
const dt = (a, b) => tl.steps[b].tMs - tl.steps[a].tMs;
const head = dt(0, 3) / 3, mid = dt(9, 12) / 3, tail = dt(tl.steps.length - 4, tl.steps.length - 1) / 3;
assert.ok(head > mid, `首段应慢于中段 (head=${head.toFixed(1)} mid=${mid.toFixed(1)})`);
assert.ok(tail > mid, `尾段应慢于中段 (tail=${tail.toFixed(1)} mid=${mid.toFixed(1)})`);
// 过冲：必中概率下倒数第二步越过目标
const tlov = buildTimeline(0, 0, 300, 0, { ...CFG, OVERSHOOT_PROB: 1, OVERSHOOT_MIN_PX: 5, OVERSHOOT_MAX_PX: 5, JITTER_PROB: 0 }, randYes);
assert.ok(tlov.steps[tlov.steps.length - 2].x > 300, 'timeline 过冲越过目标');

console.log('trajectory.test: 12 组断言全部通过 ✓');
