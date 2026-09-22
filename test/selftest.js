/**
 * scrader 全链路自测（无需 Chrome）
 * ─────────────────────────────────────────────────────────────
 * 桥接 bridge.js + 模拟扩展（原生 WebSocket 客户端）+ MCP 服务器 scrader-mcp.js
 * 验证：WS 握手/编解码、工具转发、MCP initialize/tools/list/tools/call、
 *       错误路径、扩展断开后的失败语义。
 * 运行：node selftest.js   （退出码 0 = 全部通过）
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 7831; // 测试专用端口
const { encodeFrame, decodeFrames } = require('../hands/browser/bridge.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✅ ' + name);
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// 客户端→服务端帧必须带掩码；可控制 fin/opcode 用于构造分片
function cframeRaw(str, fin, opcode) {
  const p = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  const first = (fin ? 0x80 : 0) | opcode;
  let h;
  if (p.length < 126) { h = Buffer.from([first, 0x80 | p.length]); }
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = first; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = first; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  const out = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] ^ mask[i % 4];
  return Buffer.concat([h, mask, out]);
}
function cframe(str) { return cframeRaw(str, true, 1); }

function httpJson(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ── 模拟扩展 ──
function fakeExtension() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0), handshaken = false;
    const api = { sock, frames: [], onTool: null, close: () => sock.destroy() };
    sock.on('connect', () => {
      sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString();
        if (!/HTTP\/1\.1 101/.test(head)) { reject(new Error('握手失败: ' + head.slice(0, 80))); return; }
        buf = buf.subarray(idx + 4);
        handshaken = true;
        sock.write(cframe(JSON.stringify({ type: 'hello', name: 'scrader-extension', version: '0.1.0-test' })));
        resolve(api);
      }
      const { msgs, rest } = decodeFrames(buf);
      buf = rest;
      for (const m of msgs) {
        if (m.opcode !== 1) continue;
        let msg; try { msg = JSON.parse(m.payload.toString()); } catch { continue; }
        if (msg.type === 'tool' && api.onTool) api.onTool(msg);
      }
    });
    sock.on('error', (e) => { if (!handshaken) reject(e); });
  });
}

// ── MCP 客户端（stdio） ──
function mcpSession() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'core', 'index.js')], {
    env: {
      ...process.env,
      SCRADER_PORT: String(PORT),
      // 隔离真实密钥配置：decide 用例依赖“未配置 Key”的前提，不能读到真实 providers.json
      SCRADER_PROVIDERS: path.join(__dirname, '_nonexistent_providers.json'),
    },
  });
  const lines = [];
  const waiters = [];
  let raw = '';
  child.stdout.on('data', (c) => {
    raw += c.toString();
    let i;
    while ((i = raw.indexOf('\n')) !== -1) {
      const line = raw.slice(0, i).trim();
      raw = raw.slice(i + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      lines.push(j);
      for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k](j)) waiters.splice(k, 1);
    }
  });
  const api = {
    child,
    send: (obj) => child.stdin.write(JSON.stringify(obj) + '\n'),
    wait: (pred, ms = 8000) => {
      const hit = lines.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('等待 MCP 响应超时')), ms);
        waiters.push((j) => { if (pred(j)) { clearTimeout(t); res(j); return true; } return false; });
      });
    },
  };
  return api;
}

(async () => {
  const watchdog = setTimeout(() => { console.log('⏰ 总超时'); process.exit(1); }, 25000);

  // 1) 桥接
  console.log('▶ 启动 bridge.js');
  const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'hands', 'browser', 'bridge.js')], { env: { ...process.env, SCRADER_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.stdout.on('data', (c) => process.stdout.write('   [bridge] ' + c));
  await sleep(700);

  let st = await httpJson('GET', '/status');
  check('GET /status（无扩展）', st.ok === true && st.extensionConnected === false);

  // 2) 模拟扩展接入
  console.log('▶ 模拟扩展接入 WS');
  const ext = await fakeExtension();
  await sleep(300);
  st = await httpJson('GET', '/status');
  check('扩展握手后 /status 已连接', st.extensionConnected === true && st.extensionVersion === '0.1.0-test');

  // 3) MCP 会话
  console.log('▶ 启动 scrader-mcp.js 并跑完整 MCP 交换');
  const mcp = mcpSession();
  await sleep(500);
  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest' } } });
  const init = await mcp.wait((j) => j.id === 1);
  check('MCP initialize', init.result && init.result.serverInfo && init.result.serverInfo.name === 'scrader');

  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tl = await mcp.wait((j) => j.id === 2);
  check('tools/list 数量=' + (tl.result && tl.result.tools ? tl.result.tools.length : '?'), tl.result && tl.result.tools && tl.result.tools.length >= 17);

  // 模拟扩展按工具回话；FRAG_TEST 用分片帧回一个 200KB 大消息（Chrome 发大消息会分片）
  ext.onTool = (msg) => {
    let ok = true, data;
    switch (msg.tool) {
      case 'status': data = { connected: 'connected', addr: 'test' }; break;
      case 'list_tabs': data = [{ id: 7, title: 'Fake Tab', url: 'https://example.com/', active: true }]; break;
      case 'evaluate':
        if (msg.args.code === 'FRAG_TEST') {
          const r = JSON.stringify({ id: msg.id, type: 'result', ok: true, data: 'x'.repeat(200000) });
          const a1 = Math.floor(r.length / 3), a2 = Math.floor(r.length * 2 / 3);
          ext.sock.write(cframeRaw(r.slice(0, a1), false, 1));
          ext.sock.write(cframeRaw(r.slice(a1, a2), false, 0));
          ext.sock.write(cframeRaw(r.slice(a2), true, 0));
          return;
        }
        data = { echo: msg.args.code, tabId: msg.args.tabId || null };
        break;
      case 'wait_for': data = { found: true, match: 'text', elapsed: 5 }; break;
      default: ok = false; data = 'not implemented in fake ext';
    }
    ext.sock.write(encodeFrame(JSON.stringify({ id: msg.id, type: 'result', ok, data })));
  };

  mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
  const r3 = await mcp.wait((j) => j.id === 3);
  const t3 = r3.result.content[0].text;
  check('tools/call list_tabs 往返', t3.includes('Fake Tab') && t3.includes('"id": 7'));

  mcp.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evaluate', arguments: { code: 'return 1+1', tabId: 7 } } });
  const r4 = await mcp.wait((j) => j.id === 4);
  check('tools/call evaluate 往返（含 args 透传）', r4.result.content[0].text.includes('return 1+1'));

  mcp.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'evaluate', arguments: { code: 'FRAG_TEST' } } });
  const r4b = await mcp.wait((j) => j.id === 6, 15000);
  check('分片大消息（200KB 截图级）重组', r4b.result && !r4b.result.isError && r4b.result.content[0].text.length > 190000);

  mcp.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'close_tab', arguments: { tabId: 99 } } });
  const r5 = await mcp.wait((j) => j.id === 5);
  check('错误路径 isError=true', r5.result.isError === true && r5.result.content[0].text.includes('not implemented'));

  // decide：MCP 侧未配置（SCRADER_PROVIDERS 指向不存在文件）→ 直接报错并给出配置路径，不再走扩展
  mcp.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'decide', arguments: { questions: { q: { type: 'choice', criteria: { A: 'a', B: 'b' } } } } } });
  const r7 = await mcp.wait((j) => j.id === 7);
  check('decide 未配置时 MCP 侧直接报错并给出配置路径', r7.result.isError === true && /providers\.example|config\.json|Key/.test(r7.result.content[0].text));

  // harvest：生成代码可编译且含关键算法；userConfigDir 平台自适应
  const mcpMod = require('../core/index.js');
  const hcode = mcpMod.genHarvestCode({ itemSelector: 'a[href*="-g-"]', maxItems: 5, fields: [{ key: 'price', pattern: '(\\d+)円', kind: 'int' }] });
  let compiles = true;
  try { new Function(hcode); } catch (e) { compiles = false; }
  check('harvest 生成代码可编译', compiles === true && hcode.includes('querySelectorAll') && hcode.includes('uniqueImages'));
  check('userConfigDir 平台自适应', typeof mcpMod.userConfigDir() === 'string' && mcpMod.userConfigDir().length > 0);

  // 4) 扩展断开语义
  console.log('▶ 断开扩展后调用应失败');
  ext.onTool = null;
  ext.close();
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    st = await httpJson('GET', '/status');
    if (st.extensionConnected === false) break;
  }
  check('桥接感知到扩展断开', st.extensionConnected === false);
  const r6 = await httpJson('POST', '/tool', { tool: 'list_tabs', args: {}, timeoutMs: 2000 });
  check('扩展断开后 /tool 返回明确错误', r6.ok === false && /扩展|超时|发送/.test(r6.error || ''));

  // 收尾
  mcp.child.kill(); bridge.kill();
  clearTimeout(watchdog);
  console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('自测异常:', e); process.exit(1); });
