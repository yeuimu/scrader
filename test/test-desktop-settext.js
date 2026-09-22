// e2e：find_window 跨进程找记事本 → set_text 写含反斜杠的路径 → 回读确认反斜杠完好
// 复现并验证 GitHub Release 文件对话框之战的两条铁律（需本机 cua-driver + Windows）
// 用法：node test-desktop-settext.js
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

(async () => {
  if (process.platform !== 'win32') { console.log('非 Windows，跳过'); p.kill(); process.exit(0); }

  // 1) 启动记事本
  const lr = JSON.parse(text(await call('desktop', { method: 'launch_app', args: { path: 'notepad.exe' } })));
  if (!lr.pid) { console.log('❌ 记事本启动失败:', text(await call('desktop', { method: 'launch_app', args: { path: 'notepad.exe' } })).slice(0, 200)); p.kill(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));

  // 2) find_window 按标题跨进程找（不假设 pid 可枚举）
  const fw = JSON.parse(text(await call('desktop', { method: 'find_window', args: { title: '记事本' } })));
  const win = (fw.matches || []).find((w) => w.pid === lr.pid) || (fw.matches || [])[0];
  console.log(`find_window: scanned=${fw.scanned} 命中=${fw.matches ? fw.matches.length : 0} → pid=${win && win.pid} hwnd=${win && win.window_id}`);
  if (!win) { console.log('❌ 未找到记事本窗口'); await call('desktop', { method: 'kill_app', args: { pid: lr.pid } }); p.kill(); process.exit(1); }

  // 3) get_window_state 找 Edit 元素
  const st = JSON.parse(text(await call('desktop', { method: 'get_window_state', args: { pid: win.pid, window_id: win.window_id, include_screenshot: false } })));
  const edit = (st.elements || []).find((e) => e.role === 'Edit' && (e.actions || []).includes('set_value'));
  if (!edit) { console.log('❌ 未找到 Edit 元素'); await call('desktop', { method: 'kill_app', args: { pid: win.pid } }); p.kill(); process.exit(1); }

  // 4) set_text 写反斜杠路径（type_text 会吞反斜杠的场景）
  const VAL = 'C:\\Users\\scrader\\dist\\gaze-weights.zip';
  const sr = JSON.parse(text(await call('desktop', { method: 'set_text', args: { pid: win.pid, window_id: win.window_id, element_token: edit.element_token, value: VAL } })));
  console.log('set_text:', JSON.stringify(sr));
  const ok = sr.ok === true && sr.verified === true;

  await call('desktop', { method: 'kill_app', args: { pid: win.pid } });
  console.log(ok ? '✅ 反斜杠路径经 set_text 写入并回读校验通过' : '❌ set_text 校验失败');
  p.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常:', e); p.kill(); process.exit(1); });
setTimeout(() => { console.error('超时'); p.kill(); process.exit(1); }, 90000);
