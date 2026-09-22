// eyes/vision_loop.js — 纯视觉自主循环：截图 → gaze_server 感知 → jev 决策 → cua 拟人动作 → 重感知，直至 goal_done
// 前置：gaze_server.py 已在本机运行；decide 密钥已在用户配置目录
// 用法：node vision_loop.js --title Edge --goal "把排序改为最新创建" [--type-text 文本] [--max-steps 6] [--port 8765] [--max-dim 768]
// 结束输出 ==summary== JSON：{result, steps, actions, parse_ms_total, goal}
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createClient } = require('../hands/cua/client');
const { humanGlide } = require('../hands/cua/glide');
const { pngToScreen } = require('../hands/cua/geom');
const { findWindow } = require('../hands/cua/adapter');
const { mcpDecide } = require('../core/lib/decide');

function argvFlag(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gazeParse(pngBuf, port, maxDim) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/parse?max_dim=' + maxDim, method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': pngBuf.length } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('gaze 响应异常: ' + b.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.end(pngBuf);
  });
}

(async () => {
  const title = argvFlag('title', 'Edge');
  const goal = argvFlag('goal');
  const typeText = argvFlag('type-text', '');
  const maxSteps = Number(argvFlag('max-steps', '6'));
  const minConf = Number(argvFlag('min-conf', '0.6')); // 动作类选择门槛；goal_done/stuck 无破坏性，不受此限
  const port = Number(argvFlag('port', '8765'));
  const maxDim = Number(argvFlag('max-dim', '768'));
  if (!goal) { console.error('缺少 --goal'); process.exit(2); }

  const fwRaw = await findWindow({ title });
  const fw = typeof fwRaw === 'string' ? JSON.parse(fwRaw) : fwRaw; // adapter 返回 MCP 文本形态
  if (!fw.matches || !fw.matches.length) { console.error('找不到窗口: ' + title); process.exit(2); }
  const win = fw.matches[0];
  console.log(`窗口: pid=${win.pid} wid=${win.window_id} "${win.title}"`);

  const actions = [];
  const history = [];
  let prevCands = null;      // 上一步文本候选（做 page_diff 证据）
  let lastChoice = null;     // 上一步选择（防重复）
  let repeatCount = 0;
  let parseMsTotal = 0;
  let result = 'max_steps';

  const c = createClient({ session: 'vision-loop', clientName: 'vision-loop' });
  await c.init();
  try {
    for (let step = 1; step <= maxSteps; step++) {
      // 1) 感知（MCP 通道截图在 content image 项里，不在 structuredContent）
      const r = await c.call('get_window_state', { pid: win.pid, window_id: win.window_id, include_screenshot: true, max_elements: 1 });
      const st = c.parse(r);
      const imgItem = (r.content || []).find((x) => x.type === 'image');
      if (!imgItem || !imgItem.data) throw new Error('get_window_state 未返回截图');
      const png = Buffer.from(imgItem.data, 'base64');
      const g = await gazeParse(png, port, maxDim);
      parseMsTotal += g.parse_ms;
      const cands = g.elements.filter((e) => e.kind === 'text' && e.center_px[1] >= 100 && (e.text || '').trim().length > 1).slice(0, 80);
      console.log(`\n[step ${step}] 感知 ${g.parse_ms}ms，文本候选 ${cands.length} 个`);

      // 动作效果证据：与上一步感知做文本集合 diff（出现/消失）
      let pageDiff = null;
      if (prevCands) {
        const cur = new Set(cands.map((e) => e.text));
        const prev = new Set(prevCands.map((e) => e.text));
        pageDiff = {
          appeared: cands.filter((e) => !prev.has(e.text)).map((e) => e.text.slice(0, 20)).slice(0, 8),
          disappeared: prevCands.filter((e) => !cur.has(e.text)).map((e) => e.text.slice(0, 20)).slice(0, 8),
        };
        console.log(`[step ${step}] 页面变化: +${JSON.stringify(pageDiff.appeared)} -${JSON.stringify(pageDiff.disappeared)}`);
      }
      prevCands = cands;

      // 2) 决策（jev 不可用会抛错——视觉循环没有决策者即终止）
      const criteria = {};
      for (const e of cands) {
        criteria['click_' + e.id] = `点击 "${(e.text || '').slice(0, 24)}" @(${e.center_px})`;
        if (typeText) criteria['type_' + e.id] = `点击后输入 "${typeText}"`;
      }
      criteria.enter = '按回车提交';
      criteria.scroll = '向下滚动半屏（目标可能在折叠区下方）';
      criteria.goal_done = '目标已达成';
      criteria.stuck = '无法继续';
      const repeatWarn = lastChoice
        ? `上一步动作是 ${lastChoice}${repeatCount ? `（已连续选过 ${repeatCount} 次）` : ''}——若它对目标无推进，勿再重复。`
        : '';
      const typeHint = typeText ? `本运行带待输入文本 "${typeText}"：需要输入时选 type_<id>（=点击该元素+逐字符键入一体），不要选裸 click_ 后停手。` : '';
      const d = await mcpDecide({
        state: {
          task: goal, history, page_diff: pageDiff,
          screenshot_size: [g.image.width, g.image.height],
          candidates: cands.map((e) => ({ id: e.id, text: (e.text || '').slice(0, 24), center_px: e.center_px })),
        },
        questions: { next: { type: 'choice', criteria, instructions: `当前任务：${goal}。历史动作 ${history.length ? JSON.stringify(history) : '（无，第一步）'}。page_diff 是上一动作引起的页面文本变化（新增/消失），可作为该动作是否生效的证据。${repeatWarn}${typeHint}点击后新出现的弹层/菜单项也会出现在候选里。目标已完成选 goal_done，无法推进选 stuck。` } },
      });
      const ans = d.answers && d.answers.next;
      if (!ans) throw new Error('决策无答案');
      const mLog = /^(click|type)_(\d+)$/.exec(ans.choice);
      const elLog = mLog && g.elements.find((e) => e.id === Number(mLog[2]));
      console.log(`[step ${step}] 决策 ${d.provider} → ${ans.choice}${elLog ? '("' + (elLog.text || '').slice(0, 20) + '")' : ''} (conf=${ans.confidence})`);
      if (ans.choice === 'goal_done') { console.log('✅ goal_done'); result = 'goal_done'; break; }
      if (ans.choice === 'stuck') { console.log('⛔ stuck'); result = 'stuck'; break; }
      if ((ans.confidence ?? 0) < minConf && /^(click|type)_|enter|scroll$/.test(ans.choice)) {
        console.log(`⛔ 动作置信度 ${ans.confidence} < ${minConf}，拒绝盲动（模糊目标需要更明确的措辞或更聪明的决策者）`);
        result = 'low_confidence';
        break;
      }
      if (ans.choice === lastChoice) {
        repeatCount++;
        if (repeatCount >= 2) { console.log('⛔ 同一动作连续 3 次无效，终止'); result = 'repeat_stuck'; break; }
      } else {
        repeatCount = 0;
      }
      lastChoice = ans.choice;

      // 3) 动作（前台点击跟随光标：humanGlide 先把真实指针拟人滑到目标）
      await c.call('bring_to_front', { pid: win.pid, window_id: win.window_id }).catch(() => {});
      if (ans.choice === 'enter') {
        await c.call('press_key', { session: c.session, pid: win.pid, window_id: win.window_id, key: 'enter', delivery_mode: 'foreground' });
      } else if (ans.choice === 'scroll') {
        await c.call('scroll', { session: c.session, pid: win.pid, window_id: win.window_id, x: Math.round(g.image.width / 2), y: Math.round(g.image.height / 2), clicks: 6, direction: 'down', delivery_mode: 'foreground' });
      } else {
        const m = /^(click|type)_(\d+)$/.exec(ans.choice);
        if (!m) throw new Error('未知动作 ' + ans.choice);
        const el = g.elements.find((e) => e.id === Number(m[2]));
        if (!el) throw new Error('元素不存在 ' + m[2]);
        const [sx, sy] = pngToScreen({ bounds: st.window_bounds }, el.center_px[0], el.center_px[1], g.image.width, g.image.height);
        const glide = await humanGlide(c, sx, sy);
        console.log(`[step ${step}] 滑轨 ${glide.dist}px/${glide.waypoints}wp/${glide.ms}ms → 屏幕(${sx},${sy})`);
        await c.call('click', { session: c.session, pid: win.pid, window_id: win.window_id, x: el.center_px[0], y: el.center_px[1], delivery_mode: 'foreground' });
        if (m[1] === 'type' && typeText) {
          for (const ch of typeText) {
            await c.call('press_key', { session: c.session, pid: win.pid, window_id: win.window_id, key: ch, delivery_mode: 'foreground' });
            await sleep(120);
          }
        }
      }
      history.push(elLog ? `${ans.choice}("${(elLog.text || '').slice(0, 16)}")` : ans.choice);
      actions.push(ans.choice);
      await sleep(2500); // 等页面响应后重感知
    }
  } finally {
    await c.end();
  }
  console.log(`\n==summary== ${JSON.stringify({ result, steps: history.length, actions: history, parse_ms_total: parseMsTotal, goal })}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
