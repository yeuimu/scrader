// hands/cua/glide.js — cua 后端的拟人轨迹执行器：吃 motion 生成的 timeline，照表移动真实指针
'use strict';
const { CFG, buildTimeline } = require('../../motion/trajectory');

// humanGlide(client, tx, ty)：把真实指针拟人滑到屏幕坐标 (tx, ty)；返回 {dist, waypoints, ms}
async function humanGlide(client, tx, ty, cfg = CFG) {
  const p = await client.getPos();
  const sx = p ? p[0] : 600, sy = p ? p[1] : 400;
  const tl = buildTimeline(sx, sy, tx, ty, cfg);
  const t0 = Date.now();
  for (const s of tl.steps) {
    await client.call('move_cursor', { session: client.session, scope: 'desktop', x: s.x, y: s.y });
    const wait = s.tMs - (Date.now() - t0);
    if (wait > 1) await client.sleep(wait);
  }
  return { dist: tl.dist, waypoints: tl.steps.length, ms: Date.now() - t0 };
}

module.exports = { humanGlide };
