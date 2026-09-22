// hands/cua/geom.js — cua 坐标空间换算：PNG(截图/点击空间) / 屏幕(滑行空间) / UIA(真实窗口px)
// 铁律：cua click 的 x,y = get_window_state 返回 PNG 的像素空间，感知层 center_px 直接喂
'use strict';

// 窗口几何：bounds(真实px,屏幕系原点) + 截图尺寸(PNG系)；窗口被拖动/改尺寸后必须重取
async function getGeom(client, pid, wid) {
  const at = client.parse(await client.call('get_accessibility_tree', {}));
  const wins = at.windows || at._legacy_windows || [];
  const w = wins.find((x) => x.window_id === wid) || wins.find((x) => x.pid === pid);
  const ws = client.parse(await client.call('get_window_state', { pid, window_id: wid, include_accessibility_tree: false, max_dimension: 400 }));
  const bounds = w || ws.window_bounds;
  return { bounds, pngW: ws.screenshot_width, pngH: ws.screenshot_height };
}

// PNG 坐标 → 屏幕坐标。x,y 必须与 pngW,pngH 同一坐标空间：
// 缺省用 getGeom 返回的 g.pngW/pngH（其内部截图是 max_dimension 压缩小图）；
// 坐标若来自别处的全尺寸截图（如感知层 center_px），必须显式传那次的 pngW,pngH，否则缩放翻倍
function pngToScreen(g, x, y, pngW = g.pngW, pngH = g.pngH) {
  return [
    Math.round(g.bounds.x + x * g.bounds.width / pngW),
    Math.round(g.bounds.y + y * g.bounds.height / pngH),
  ];
}

// UIA 元素中心 → {png:[x,y] 供 click, screen:[x,y] 供 humanGlide}
function uiaCenterTo(g, frame) {
  const cx = frame.x + frame.w / 2, cy = frame.y + frame.h / 2;
  return {
    png: [Math.round(cx * g.pngW / g.bounds.width), Math.round(cy * g.pngH / g.bounds.height)],
    screen: [Math.round(g.bounds.x + cx), Math.round(g.bounds.y + cy)],
  };
}

module.exports = { getGeom, pngToScreen, uiaCenterTo };
