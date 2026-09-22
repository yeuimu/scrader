// e2e：经 scrader desktop 工具（MCP 全链路）操作 Windows 计算器算 6×7，验证 42 后关闭
// 用法：node test-desktop-e2e.js（自动启动计算器）| node test-desktop-e2e.js <pid> <window_id>
'use strict';
const cp = require('child_process');
const path = require('path');
const p = cp.spawn(process.execPath, [path.join(__dirname, '..', 'core', 'index.js')], { stdio: ['pipe', 'pipe', 'ignore'] });

let buf = '';
let next = 1;
const pending = new Map();
p.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j.result); pending.delete(j.id); }
  }
});
function call(name, args) {
  return new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}
const text = (r) => (r && r.content && r.content[0] ? r.content[0].text : '');
const refused = (t) => /"status"\s*:\s*"refused"/.test(t);

(async () => {
  let PID = Number(process.argv[2] || 0);
  let WIN = Number(process.argv[3] || 0);
  if (!PID) {
    const lr = text(await call('desktop', { method: 'launch_app', args: { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' } }));
    const lj = JSON.parse(lr);
    PID = lj.pid;
    WIN = lj.windows && lj.windows[0] ? lj.windows[0].window_id : null;
    if (!WIN) { // 窗口未及物化，补查一次
      await new Promise((r) => setTimeout(r, 1200));
      const wj = JSON.parse(text(await call('desktop', { method: 'list_windows', args: { pid: PID } })));
      WIN = (wj.windows || [])[0] && wj.windows[0].window_id;
    }
  }
  console.log(`计算器 pid=${PID} window=${WIN}`);

  const state = async () => {
    const t = text(await call('desktop', { method: 'get_window_state', args: { pid: PID, window_id: WIN } }));
    return JSON.parse(t);
  };
  const st0 = await state();
  const tok = (label) => {
    const el = (st0.elements || []).find((e) => (e.label || '') === label && (e.actions || []).includes('invoke'));
    return el && el.element_token;
  };
  const click = async (label) => {
    const token = tok(label);
    if (!token) { console.log(`✗ 未找到[${label}]`); return false; }
    const t = text(await call('desktop', { method: 'click', args: { pid: PID, window_id: WIN, element_token: token } }));
    const bad = refused(t);
    console.log(`点击[${label}]`, bad ? '✗ refused: ' + t.slice(0, 120) : '✓');
    return !bad;
  };
  for (const l of ['六', '乘以', '七', '等于']) {
    if (!(await click(l))) { p.kill(); process.exit(1); }
  }
  const st1 = await state();
  const disp = (st1.elements || []).find((e) => /^显示为/.test(e.label || ''));
  const label = disp && disp.label;
  console.log('显示屏:', label);
  const ok = label && /42/.test(label);
  console.log(ok ? '✅ 6×7=42 端到端验证通过（UIA 后台点击，全程未抢焦点）' : '❌ 结果异常');
  await call('desktop', { method: 'kill_app', args: { pid: PID } });
  console.log('关闭计算器 ✓');
  p.kill();
  process.exit(ok ? 0 : 1);
})();
setTimeout(() => { console.error('超时'); p.kill(); process.exit(1); }, 90000);
