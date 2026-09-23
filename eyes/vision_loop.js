// eyes/vision_loop.js — 纯视觉自主循环：截图 → gaze_server 感知 → jev 决策 → cua 拟人动作 → 重感知，直至 goal_done
// 前置：gaze_server.py 已在本机运行；decide 密钥已在用户配置目录
// 用法：node vision_loop.js --title Edge --goal "把排序改为最新创建" [--type-text 文本] [--max-steps 6] [--port 8765] [--max-dim 768]
// 结束输出 ==summary== JSON：{result, steps, actions, parse_ms_total, goal}
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
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

function gazeParse(pngBuf, port, maxDim, crop) {
  return new Promise((resolve, reject) => {
    const p = '/parse?max_dim=' + maxDim + (crop ? '&crop=' + crop : '');
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': pngBuf.length } }, (res) => {
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
  const escalate = process.argv.includes('--escalate'); // 低置信时写 ask.json 等上级裁决（两级决策脑）
  const typeClear = process.argv.includes('--type-clear'); // 键入前先全选删除（替换语义）
  const escTimeout = Number(argvFlag('escalate-timeout', '180'));
  const ESC_DIR = path.resolve('.vision-escalate');
  const ASK_FILE = path.join(ESC_DIR, 'ask.json');
  const ANS_FILE = path.join(ESC_DIR, 'answer.json');
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
  let pendingShot = null; // 上一轮动作后的稳定帧（感知预取），下一轮直接消费
  let prevCands = null;      // 上一步文本候选（做 page_diff 证据）
  let lastPngSha = null, lastG = null; // 画面未变时整页感知复用
  let typeVerified = 0, typeVerifyFailed = 0;
  let lastChoice = null;     // 上一步选择（防重复）
  let repeatCount = 0;
  let parseMsTotal = 0;
  let degradedCount = 0;
  let result = 'max_steps';

  const c = createClient({ session: 'vision-' + win.window_id, clientName: 'vision-loop' });
  await c.init();
  try {
    for (let step = 1; step <= maxSteps; step++) {
      const stepT0 = Date.now();
      // 1) 感知（优先消费上轮动作后的稳定帧；首轮现拍。MCP 通道截图在 content image 项里）
      const r = pendingShot || await c.call('get_window_state', { pid: win.pid, window_id: win.window_id, include_screenshot: true, max_elements: 1 });
      pendingShot = null;
      const st = c.parse(r);
      const imgItem = (r.content || []).find((x) => x.type === 'image');
      if (!imgItem || !imgItem.data) throw new Error('get_window_state 未返回截图');
      const png = Buffer.from(imgItem.data, 'base64');
      const pngSha = crypto.createHash('sha1').update(png).digest('hex');
      let g, reused = false;
      if (pngSha === lastPngSha && lastG) { g = lastG; reused = true; }
      else { g = await gazeParse(png, port, maxDim); parseMsTotal += g.parse_ms; lastPngSha = pngSha; lastG = g; }
      const cands = g.elements.filter((e) => e.kind === 'text' && e.center_px[1] >= 100 && (e.text || '').trim().length > 1).slice(0, 80);
      const icons = g.elements.filter((e) => e.kind === 'icon' && e.center_px[1] >= 100).slice(0, 12);
      console.log(`\n[step ${step}] 感知 ${g.parse_ms}ms${reused ? '（画面未变，复用上轮）' : ''}，文本候选 ${cands.length} 个，图标候选 ${icons.length} 个`);

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
      for (const e of icons) {
        if (!criteria['click_' + e.id]) criteria['click_' + e.id] = `点击图标(无文字的图形按钮) @(${e.center_px})`;
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
          candidates: [
            ...cands.map((e) => ({ id: e.id, text: (e.text || '').slice(0, 24), center_px: e.center_px })),
            ...icons.map((e) => ({ id: e.id, text: '〔图标〕', center_px: e.center_px })),
          ],
        },
        questions: { next: { type: 'choice', criteria, instructions: `当前任务：${goal}。历史动作 ${history.length ? JSON.stringify(history) : '（无，第一步）'}。page_diff 是上一动作引起的页面文本变化（新增/消失），可作为该动作是否生效的证据。${repeatWarn}${typeHint}点击后新出现的弹层/菜单项也会出现在候选里。目标已完成选 goal_done，无法推进选 stuck。` } },
      });
      let ans = d.answers && d.answers.next;
      if (!ans) throw new Error('决策无答案');
      let mLog = /^(click|type)_(\d+)$/.exec(ans.choice);
      let elLog = mLog && g.elements.find((e) => e.id === Number(mLog[2]));
      console.log(`[step ${step}] 决策 ${d.provider} → ${ans.choice}${elLog ? '("' + (elLog.text || '').slice(0, 20) + '")' : ''} (conf=${ans.confidence})`);

      // 2.4) 两级决策脑（升级裁决）：写 ask.json → 轮询 answer.json → 返回上级选择的 choice 或 null
      const askSuperior = async (note) => {
        fs.rmSync(ANS_FILE, { force: true });
        const ask = {
          goal, step, history, page_diff: pageDiff, type_text: typeText || null, note: note || null,
          jev_answer: { choice: ans.choice, confidence: ans.confidence },
          candidates: [
            ...cands.map((e) => ({ id: e.id, text: (e.text || '').slice(0, 30), center_px: e.center_px })),
            ...icons.map((e) => ({ id: e.id, text: '〔图标〕', center_px: e.center_px })),
          ],
          allowed: Object.keys(criteria), how: '写 ' + ANS_FILE + '：{"choice":"<allowed之一>"}',
        };
        fs.mkdirSync(ESC_DIR, { recursive: true });
        fs.writeFileSync(ASK_FILE, JSON.stringify(ask, null, 1));
        console.log(`[step ${step}] ⏳ 等待上级裁决: ${ASK_FILE}（≤${escTimeout}s）`);
        let answer = null;
        const deadline = Date.now() + escTimeout * 1000;
        while (Date.now() < deadline) {
          await sleep(2000);
          if (fs.existsSync(ANS_FILE)) {
            try { answer = JSON.parse(fs.readFileSync(ANS_FILE, 'utf8')); } catch { answer = null; }
            fs.rmSync(ANS_FILE, { force: true });
            break;
          }
        }
        fs.rmSync(ASK_FILE, { force: true });
        if (!answer || !answer.choice || !ask.allowed.includes(answer.choice)) return null;
        return answer.choice;
      };

      if (ans.choice === 'goal_done') {
        // goal_done 证据闸：最后动作页面零变化时，"完成"声明不可信 → 升级请上级确认
        const noEvidence = history.length > 0 && pageDiff && (pageDiff.appeared.length + pageDiff.disappeared.length) === 0;
        if (!noEvidence || !escalate) {
          if (noEvidence) console.log('⚠ goal_done 缺少页面变化证据（未启用 --escalate，姑且采信）');
          console.log('✅ goal_done'); result = 'goal_done'; break;
        }
        console.log('⚠ jev 声称 goal_done 但最后动作无页面变化，升级请上级确认');
        const confirmed = await askSuperior('jev 声称 goal_done，但最后动作没有引起任何页面文本变化；若目标确实达成请仍答 goal_done，否则改选正确动作');
        if (confirmed === 'goal_done') { console.log('✅ goal_done（上级确认）'); result = 'goal_done'; break; }
        if (confirmed === null) { console.log('⚠ 上级未确认，标记为未验证完成'); result = 'goal_done_unverified'; degradedCount++; break; }
        ans = { choice: confirmed, confidence: 1 };
        mLog = /^(click|type)_(\d+)$/.exec(ans.choice);
        elLog = mLog && g.elements.find((e) => e.id === Number(mLog[2]));
      }
      if (ans.choice === 'stuck') { console.log('⛔ stuck'); result = 'stuck'; break; }

      // 2.5) 两级决策脑：动作置信度不足时，交给上级裁决；超时且 jev 原答案达硬底线(0.4)则降级执行
      if ((ans.confidence ?? 0) < minConf && /^(click|type)_|enter|scroll$/.test(ans.choice)) {
        if (!escalate) {
          console.log(`⛔ 动作置信度 ${ans.confidence} < ${minConf}，拒绝盲动（--escalate 可启用上级裁决）`);
          result = 'low_confidence';
          break;
        }
        const answer = await askSuperior();
        if (!answer) {
          if ((ans.confidence ?? 0) >= 0.4) {
            console.log(`⚠ 裁决超时，降级执行 jev 原答案 ${ans.choice} (conf=${ans.confidence}，risk)`);
            degradedCount++;
          } else {
            console.log('⛔ 上级裁决超时且 jev 原答案置信度过低'); result = 'low_confidence'; break;
          }
        } else if (answer === 'goal_done') {
          console.log('✅ goal_done（上级确认）'); result = 'goal_done'; break;
        } else if (answer === 'stuck') {
          console.log('⛔ stuck（上级确认）'); result = 'stuck'; break;
        } else {
          console.log(`[step ${step}] 上级裁决 → ${answer}`);
          ans = { choice: answer, confidence: 1 };
          mLog = /^(click|type)_(\d+)$/.exec(ans.choice);
          elLog = mLog && g.elements.find((e) => e.id === Number(mLog[2]));
        }
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
          if (typeClear) { // 替换语义：END 到行尾后连发 BACKSPACE 清空。cua 特殊键名要大写（BACKSPACE），
            // 小写会被静默丢弃；hotkey 组合键（ctrl+a）实测是哑弹，勿依赖
            await c.call('press_key', { session: c.session, pid: win.pid, window_id: win.window_id, key: 'END', delivery_mode: 'foreground' });
            await sleep(250);
            for (let i = 0; i < 40; i++) {
              await c.call('press_key', { session: c.session, pid: win.pid, window_id: win.window_id, key: 'BACKSPACE', delivery_mode: 'foreground' });
              await sleep(45);
            }
            await sleep(250);
          }
          for (const ch of typeText) {
            await c.call('press_key', { session: c.session, pid: win.pid, window_id: win.window_id, key: ch, delivery_mode: 'foreground' });
            await sleep(120);
          }
          // 键入落框验证：目标元素附近小区域裁剪 OCR（~1s），防焦点漂移静默丢失
          await sleep(400);
          try {
            const rr = await c.call('get_window_state', { pid: win.pid, window_id: win.window_id, include_screenshot: true, max_elements: 1 });
            const im2 = (rr.content || []).find((x) => x.type === 'image');
            const png2 = Buffer.from(im2.data, 'base64');
            const b = el.bbox_px;
            const cx0 = Math.max(0, b[0] - 24), cy0 = Math.max(0, b[1] - 24);
            const crop = [cx0, cy0, Math.min(g.image.width, b[2] + 24) - cx0, Math.min(g.image.height, b[3] + 24) - cy0].join(',');
            const vr = await gazeParse(png2, port, 0, crop);
            const hitText = vr.elements.some((e) => (e.text || '').includes(typeText));
            if (hitText) { typeVerified++; console.log(`✓ 键入落框验证通过（裁剪OCR: "${vr.elements.map((e) => e.text).join(' ')}"）`); }
            else { typeVerifyFailed++; console.log(`⚠ 键入未在目标区域读到（焦点可能丢失）: 裁剪OCR="${vr.elements.map((e) => e.text).join(' ')}"`); }
          } catch (e) { console.log('⚠ 键入验证异常: ' + e.message); }
        }
      }
      history.push(elLog ? `${ans.choice}("${(elLog.text || '').slice(0, 16)}")` : ans.choice);
      actions.push(ans.choice);
      // 感知预取：页面稳定检测（PNG 尺寸连续两帧近同即稳定，光标闪烁级抖动忽略），稳定帧供下轮感知
      pendingShot = null;
      let prevLen = null, stable = 0;
      for (let i = 0; i < 5 && Date.now() - stepT0 < 6000; i++) {
        await sleep(650);
        try {
          const rr = await c.call('get_window_state', { pid: win.pid, window_id: win.window_id, include_screenshot: true, max_elements: 1 });
          const img = (rr.content || []).find((x) => x.type === 'image');
          if (!img || !img.data) continue;
          pendingShot = rr;
          const len = img.data.length;
          if (prevLen !== null && Math.abs(len - prevLen) < 150) { if (++stable >= 1) break; } else { stable = 0; }
          prevLen = len;
        } catch {}
      }
    }
  } finally {
    await c.end();
  }
  console.log(`\n==summary== ${JSON.stringify({ result, steps: history.length, actions: history, degraded_actions: degradedCount, type_verified: typeVerified, type_verify_failed: typeVerifyFailed, parse_ms_total: parseMsTotal, goal })}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
