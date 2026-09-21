// desktop 工具未装 cua 时的优雅降级验证
'use strict';
const cp = require('child_process');
const p = cp.spawn(process.execPath, [require('path').join(__dirname, 'scrader-mcp.js')], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: { ...process.env, SCRADER_PROVIDERS: require('path').join(__dirname, '_nonexistent_providers.json') },
});
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.id === 1) {
      const names = j.result.tools.map((t) => t.name);
      console.log('tools:', names.length, names.includes('desktop') ? '含desktop ✓' : '缺desktop ✗');
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desktop', arguments: { args: ['status'] } } });
    } else if (j.id === 2) {
      const text = j.result.content[0].text;
      console.log('desktop(status):', text.slice(0, 100));
      const ok = /未安装|PATH|cua/.test(text);
      console.log(/未安装或不在 PATH/.test(text) ? '优雅报错 ✓（未装 cua 时返回安装指引）' : 'cua 已安装，返回: ' + (ok ? '正常输出' : text.slice(0, 60)));
      p.kill();
      process.exit(0);
    }
  }
  buf = buf.slice(buf.lastIndexOf('\n') + 1);
});
function send(o) { p.stdin.write(JSON.stringify(o) + '\n'); }
send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
setTimeout(() => { console.error('超时'); p.kill(); process.exit(1); }, 20000);
