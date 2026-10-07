// test/test-live-mcp.js — 活体集成测试（依赖本机 bridge/扩展，不进默认 npm test）
// 验证：新 MCP 进程的 status 输出 bridge.clients 多客户端清单；桥被杀后下一次调用自动拉起。
// 用法: node test/test-live-mcp.js
'use strict';
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => { failed++; console.log('  ❌ ' + m); };

function bridgeStatus() {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 7827, path: '/status', timeout: 2000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function mcpCall(proc, id, name, args) {
  return new Promise((resolve, reject) => {
    const line = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } });
    const onData = (buf) => {
      for (const l of buf.toString().split('\n')) {
        if (!l.trim()) continue;
        try { const j = JSON.parse(l); if (j.id === id) { proc.stdout.off('data', onData); resolve(j); return; } } catch {}
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(line + '\n');
    setTimeout(() => { proc.stdout.off('data', onData); reject(new Error('mcp call timeout')); }, 20000);
  });
}

async function main() {
  const before = await bridgeStatus();
  if (!before || !before.extensionConnected) { console.log('⏭ 扩展未在线，跳过活体测试'); process.exit(0); }
  ok(`前置：bridge 在线，客户端 ${before.clients.length} 个 [${before.clients.map((c) => c.label).join(',')}]`);

  const proc = spawn(process.execPath, [path.join(ROOT, 'core', 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-test', version: '0' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 500));

  // 1) status 含 bridge.clients（新 router 代码；扩展 SW 唤醒有竞态，允许重试一次）
  let st = null;
  for (let i = 0; i < 2 && !(st && st.bridge && Array.isArray(st.bridge.clients) && st.bridge.clients.length >= 1); i++) {
    const r1 = await mcpCall(proc, 10 + i, 'status');
    const txt = (r1.result && r1.result.content && r1.result.content[0] && r1.result.content[0].text) || '';
    try { st = JSON.parse(txt); } catch { st = null; }
    if (i === 0 && !(st && st.bridge)) await new Promise((r) => setTimeout(r, 2000));
  }
  if (st && st.bridge && Array.isArray(st.bridge.clients) && st.bridge.clients.length >= 1) ok(`status 输出 clients: [${st.bridge.clients.map((c) => c.label + ':' + c.version).join(', ')}]`);
  else bad('status 缺 bridge.clients');

  // 2) 杀 bridge → 下一次工具调用应自动拉起
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bridge\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { encoding: 'utf8' });
  } catch {}
  await new Promise((r) => setTimeout(r, 800));
  const dead = await bridgeStatus();
  if (dead === null) ok('bridge 已被杀死（/status 不可达）'); else bad('bridge 仍在线，杀进程失败（跳过复活测试）');

  const t0 = Date.now();
  const r2 = await mcpCall(proc, 2, 'list_tabs'); // 浏览器工具走通用路径：桥死→拉起→等扩展回连→重试
  const revived = await bridgeStatus();
  const txt2 = (r2.result && r2.result.content && r2.result.content[0] && r2.result.content[0].text) || '';
  const ok2 = !r2.error && !r2.result.isError && revived && revived.ok && txt2.includes('http');
  ok2 ? ok(`桥自动复活+扩展回连（${((Date.now() - t0) / 1000).toFixed(1)}s），list_tabs 正常，clients=${revived.clients.length}`) : bad('桥/扩展未自愈: ' + JSON.stringify(r2).slice(0, 150));

  // 3) status 也能自愈（拉活后调用）
  const r3 = await mcpCall(proc, 3, 'status');
  const txt3 = (r3.result && r3.result.content && r3.result.content[0] && r3.result.content[0].text) || '';
  txt3.includes('"clients"') && txt3.includes('"connected"') ? ok('status 输出完整（clients + connected）') : bad('status 输出异常: ' + txt3.slice(0, 120));

  proc.kill();
  console.log(failed ? `❌ live-mcp ${failed} 项未过` : '✅ live-mcp 全部通过');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('live-mcp FAILED:', e.message); process.exit(1); });
