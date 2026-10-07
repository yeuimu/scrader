// test/test-bridge.js — bridge 多客户端隔离与路由回归
// 伪造两个原始 WebSocket 客户端（Chrome UA / Edge UA），验证：
//   1) 双客户端共存不互踢（旧实现单槽位会踢掉前一个）
//   2) /status 列出两个客户端且 UA 标记正确
//   3) "tab 不存在"错误自动转移到另一个客户端
'use strict';
const assert = require('assert');
const net = require('net');
const http = require('http');

process.env.SCRADER_PORT = '0'; // 由 server.listen 实际分配后再读

async function main() {
  const bridgePath = require('path').join(__dirname, '..', 'hands', 'browser', 'bridge.js');
  const { server, callTool, _internals } = require(bridgePath);
  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));

  // ── 原始 WS 客户端：完成 upgrade 握手 + 收发文本帧 ──
  function fakeExt(ua) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      const crypto = require('crypto');
      const key = crypto.randomBytes(16).toString('base64');
      sock.once('connect', () => {
        sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: ${ua}\r\n\r\n`);
      });
      let buf = Buffer.alloc(0);
      let handshake = false;
      const client = {
        sock,
        onTool: null,
        send(obj) {
          const p = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
          let h;
          if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
          else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
          sock.write(Buffer.concat([h, mask, p]));
        },
      };
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!handshake) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          buf = buf.subarray(idx + 4);
          handshake = true;
          client.send({ type: 'hello', version: 'test-0.0.1' });
          resolve(client);
        }
        // 解析服务端（未掩码）文本帧
        while (buf.length >= 2) {
          const len = buf[1] & 0x7f;
          if (buf.length < 2 + len) break;
          const payload = buf.subarray(2, 2 + len).toString('utf8');
          buf = buf.subarray(2 + len);
          let msg; try { msg = JSON.parse(payload); } catch { continue; }
          if (msg.type === 'tool' && client.onTool) client.onTool(msg, (ok, data) => client.send({ type: 'result', id: msg.id, ok, data }));
        }
      });
      sock.on('error', reject);
    });
  }

  // 1) Chrome 先连，Edge 再连 —— 旧的 attachExtension 会踢掉 Chrome
  const chrome = await fakeExt('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36');
  const edge = await fakeExt('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0');
  await new Promise((r) => setTimeout(r, 150));

  let clients = _internals.listClients();
  assert.strictEqual(clients.length, 2, '两个扩展应共存，实际: ' + JSON.stringify(clients));
  assert.deepStrictEqual(clients.map((c) => c.label).sort(), ['chrome', 'edge'], 'UA 标记应区分 chrome/edge');

  // 2) /status 暴露 clients
  const st = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/status' }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
  assert.ok(st.extensionConnected, 'extensionConnected 应为 true');
  assert.strictEqual(st.clients.length, 2, '/status 应列出 2 个客户端');

  // 3) 路由转移：主客户端回 "tab 不存在" → 自动落到另一个客户端
  let calls = [];
  chrome.onTool = (msg, done) => { calls.push('chrome:' + msg.tool); done(false, '标签页 999 不存在'); };
  edge.onTool = (msg, done) => { calls.push('edge:' + msg.tool); done(true, { via: 'edge' }); };
  const out = await callTool('read_page', { tabId: 999 }, 5000);
  assert.deepStrictEqual(out, { via: 'edge' }, '失败应转移到 edge');
  assert.deepStrictEqual(calls, ['chrome:read_page', 'edge:read_page'], '调用链应为 chrome→edge');

  // 4) 显式 browser 提示直接命中
  calls = [];
  const out2 = await callTool('status', { browser: 'edge' }, 5000);
  assert.deepStrictEqual(calls, ['edge:status'], 'browser=edge 应只走 edge');

  // 5) 断开一个，另一个照常服务
  chrome.sock.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(_internals.listClients().length, 1, '断开后应剩 1 个');
  edge.onTool = (msg, done) => done(true, { alive: true });
  const out3 = await callTool('read_page', {}, 5000);
  assert.deepStrictEqual(out3, { alive: true });
  edge.sock.destroy();
  server.close();

  console.log('test-bridge: 5 组断言全部通过 ✓');
}

main().catch((e) => { console.error('test-bridge FAILED:', e.message); process.exit(1); });
