// ⚠️ 构建产物：由 scripts/build-extension.js 从 motion/trajectory.js 生成，勿手改。
// 改算法请编辑 motion/trajectory.js 后运行 npm run build:extension 并重载扩展。
// motion/trajectory.js — 拟人层（横切）：算法与参数唯一源，浏览器/cua 双后端共用
// 设计：buildWaypoints/buildTimeline 全部纯函数（可离线单测，rand 可注入）；
//      各执行面只写 ~15 行"照表执行"的薄执行器（hands/cua/glide.js、扩展 vendor 版）。
// 参数谱系：移植自 enikk _human_move_to（MIT）+ 实战调优（2026-09-22，81.3Hz 实测）。
'use strict';

// 调"更像人/更快/更慢"只改这一处
const CFG = {
  SEG_PX: 15,                 // 每 ~15px 一个航点
  ARC_MIN: 0.10,              // 弧线偏移 = 距离 × [ARC_MIN, ARC_MAX]，方向随机
  ARC_MAX: 0.25,
  DUR_MIN_MS: 200,            // 时长 = clamp(dist × SPEED, 0.2s, 0.7s)
  DUR_MAX_MS: 700,
  SPEED_PX_PER_MS: 1 / 800,   // 峰值 ~800px/s
  OVERSHOOT_PROB: 0.3,        // 过冲回正概率（距离 > OVERSHOOT_MIN_DIST 时）
  OVERSHOOT_MIN_DIST: 30,
  OVERSHOOT_MIN_PX: 3,        // 过冲量 [3, 8]px 沿行进方向冲过目标，随后精确回正
  OVERSHOOT_MAX_PX: 8,
  JITTER_PROB: 0.3,           // 航点微颤概率（真人手抖是低频漂移，不是每帧抖）
  JITTER_PX: 1.5,
  SLOW_ENDS_FACTOR: 0.5,      // 首尾减速强度：步距 ×(1 + F·(1−sin(π·eased)))
};

// 三次贝塞尔(法向控制点) + smoothstep 缓动 + 可选过冲 → 航点几何序列 [{x,y,eased}]
function buildWaypoints(sx, sy, tx, ty, cfg = CFG, rand = Math.random) {
  const c = { ...CFG, ...cfg };
  const dx = tx - sx, dy = ty - sy, dist = Math.hypot(dx, dy);
  if (dist < 2) return [{ x: tx, y: ty, eased: 1 }];
  const nx = -dy / dist, ny = dx / dist;   // 法向（弧线用）
  const ux = dx / dist, uy = dy / dist;    // 行进方向（过冲用）
  const arc = dist * (c.ARC_MIN + rand() * (c.ARC_MAX - c.ARC_MIN)) * (rand() < 0.5 ? 1 : -1);
  const c1x = sx + dx * 0.25 + nx * arc, c1y = sy + dy * 0.25 + ny * arc;
  const c2x = sx + dx * 0.75 + nx * arc * 0.6, c2y = sy + dy * 0.75 + ny * arc * 0.6;
  const n = Math.max(Math.floor(dist / c.SEG_PX), 8);
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t, eased = t * t * (3 - 2 * t);
    const bx = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx;
    const by = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty;
    pts.push({ x: sx + (bx - sx) * eased, y: sy + (by - sy) * eased, eased });
  }
  if (rand() < c.OVERSHOOT_PROB && dist > c.OVERSHOOT_MIN_DIST) {
    const o = c.OVERSHOOT_MIN_PX + rand() * (c.OVERSHOOT_MAX_PX - c.OVERSHOOT_MIN_PX);
    pts.push({ x: tx + ux * o, y: ty + uy * o, eased: 1 });
    pts.push({ x: tx, y: ty, eased: 1 });
  }
  return pts;
}

// 完整运动计划（几何 + 节奏 + 微颤）→ { dist, dur, steps:[{x, y, tMs}] }
// 执行器只需"在 tMs 毫秒时把指针放到 (x, y)"——两个后端吃同一张表，拟人特征完全一致。
function buildTimeline(sx, sy, tx, ty, cfg = CFG, rand = Math.random) {
  const c = { ...CFG, ...cfg };
  const dist = Math.hypot(tx - sx, ty - sy);
  const base = Math.min(Math.max(dist * c.SPEED_PX_PER_MS * 1000, c.DUR_MIN_MS), c.DUR_MAX_MS);
  const wps = buildWaypoints(sx, sy, tx, ty, cfg, rand);
  const steps = [];
  let t = 0;
  for (const w of wps) {
    const stepMs = (base / wps.length) * (1 + c.SLOW_ENDS_FACTOR * (1 - Math.sin(Math.PI * w.eased)));
    t += stepMs;
    const jit = rand() < c.JITTER_PROB ? (rand() - 0.5) * 2 * c.JITTER_PX : 0;
    const jitY = rand() < c.JITTER_PROB ? (rand() - 0.5) * 2 * c.JITTER_PX : 0;
    steps.push({ x: Math.round(w.x + jit), y: Math.round(w.y + jitY), tMs: Math.round(t) });
  }
  // 终点必须精确（微颤不得污染最后一格）
  const last = steps[steps.length - 1];
  last.x = Math.round(wps[wps.length - 1].x);
  last.y = Math.round(wps[wps.length - 1].y);
  return { dist: Math.round(dist), dur: last.tMs, steps };
}


