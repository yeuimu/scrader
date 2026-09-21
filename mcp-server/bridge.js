/**
 * scrader bridge —— 本地桥接进程（纯 Node，零依赖）
 * ─────────────────────────────────────────────────────────────
 *  - WebSocket 服务  ws://127.0.0.1:<port>/ws   ← scrader 扩展连这里
 *  - HTTP API        POST /tool {tool,args,timeoutMs} → {ok,data|error}
 *                    GET  /status
 *  - 工具调用经 WS 转发给扩展，回传结果；扩展断开时挂起请求立即失败
 *  - 可选审计日志：环境变量 SCRADER_LOG=<文件路径> 时追加每次调用
 *
 * 启动：node bridge.js   （端口默认 7827，可用 SCRADER_PORT 覆盖；
 *        scrader-mcp.js 发现桥接不在时会自动拉起本进程）
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.SCRADER_PORT || '7827', 10);
const DEFAULT_TIMEOUT_MS = 90000;
const LOG_FILE = process.env.SCRADER_LOG || '';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ───────────────────── WebSocket 帧编解码（RFC 6455 子集） ─────────────────────
// 支持文本帧 + ping/pong/close；不支持分片（Chrome 对常规 send() 不分片）

function encodeFrame(str, opcode = 1) {
  const p = Buffer.from(str, 'utf8');
  const op = opcode === 9 ? 0x89 : opcode === 10 ? 0x8A : opcode === 8 ? 0x88 : 0x81;
  let h;
  if (p.length < 126) { h = Buffer.from([op, p.length]); }
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = op; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = op; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}

function decodeFrames(buf) {
  const msgs = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (buf.length - p < 4) break; mask = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    let payload = Buffer.from(buf.subarray(p, p + len)); // 拷贝，防 subarray 悬挂
    if (mask) { for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4]; }
    msgs.push({ fin, opcode, payload });
    off = p + len;
  }
  return { msgs, rest: buf.length === off ? Buffer.alloc(0) : Buffer.from(buf.subarray(off)) };
}

// ───────────────────── 扩展连接管理 ─────────────────────

let ext = null;            // { sock, version, buffer }
const pending = new Map(); // id → { resolve, reject, timer }
let nextId = 1;

function audit(line) {
  if (!LOG_FILE) return;
  fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, () => {});
}

function extSend(obj) {
  if (!ext || ext.sock.destroyed || !ext.sock.writable) return false;
  try { return ext.sock.write(encodeFrame(JSON.stringify(obj))) !== false; } catch { return false; }
}

function attachExtension(sock) {
  if (ext) { try { ext.sock.destroy(); } catch {} }
  ext = { sock, version: '', buffer: Buffer.alloc(0) };
  ext.frag = null; // 分片重组状态：Chrome 对大消息（如截图 base64）会分片发送
  sock.on('data', (chunk) => {
    ext.buffer = Buffer.concat([ext.buffer, chunk]);
    const { msgs, rest } = decodeFrames(ext.buffer);
    ext.buffer = rest;
    for (const m of msgs) {
      if (m.opcode === 8) { sock.end(encodeFrame('', 8)); dropExtension('extension closed'); return; }
      if (m.opcode === 9) { try { sock.write(encodeFrame(m.payload.toString('utf8'), 10)); } catch {} continue; }
      if (m.opcode === 10) continue; // pong
      // 分片消息：首帧 opcode=1 fin=0，后续 opcode=0，末帧 fin=1
      if (m.opcode === 0 || !m.fin) {
        if (m.opcode !== 0 && m.opcode !== 1) continue;
        ext.frag = ext.frag || { opcode: 1, parts: [], size: 0 };
        ext.frag.parts.push(m.payload);
        ext.frag.size += m.payload.length;
        if (ext.frag.size > 64 * 1024 * 1024) { sock.destroy(); dropExtension('message too large'); return; }
        if (!m.fin) continue;
        const full = Buffer.concat(ext.frag.parts).toString('utf8');
        ext.frag = null;
        let fm;
        try { fm = JSON.parse(full); } catch { continue; }
        handleExtMsg(fm);
        continue;
      }
      if (m.opcode !== 1) continue;
      let msg;
      try { msg = JSON.parse(m.payload.toString('utf8')); } catch { continue; }
      handleExtMsg(msg);
    }
  });
  sock.on('end', () => { try { sock.end(); } catch {} if (ext && ext.sock === sock) dropExtension('extension ended (FIN)'); }); // 半关闭：对端只 FIN 不发 close 帧时也要感知
  sock.on('close', () => { if (ext && ext.sock === sock) dropExtension('socket closed'); });
  sock.on('error', () => { if (ext && ext.sock === sock) dropExtension('socket error'); });
}

function dropExtension(reason) {
  if (!ext) return;
  console.log(`[scrader-bridge] extension disconnected: ${reason}`);
  const dead = ext;
  ext = null;
  try { dead.sock.destroy(); } catch {}
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('扩展已断开: ' + reason)); }
  pending.clear();
}

function handleExtMsg(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') {
    ext.version = msg.version || '';
    console.log(`[scrader-bridge] extension connected (v${ext.version})`);
    return;
  }
  if (msg.type === 'ping') { extSend({ type: 'pong', t: msg.t }); return; }
  if (msg.type === 'result' && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(Object.assign(new Error(String(msg.data || 'tool failed'))));
  }
}

function callTool(tool, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!ext) { reject(new Error('扩展未连接（打开 Chrome 并确认 scrader 扩展已启用；popup 应显示"已连接桥接"）')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`工具 ${tool} 超时(${timeoutMs}ms)`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (!extSend({ id, type: 'tool', tool, args })) {
      pending.delete(id); clearTimeout(timer);
      reject(new Error('发送给扩展失败'));
    }
  });
}

// ───────────────────── HTTP 服务 ─────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/status' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, name: 'scrader-bridge', port: PORT,
      extensionConnected: !!ext, extensionVersion: ext ? ext.version : null,
      pendingCalls: pending.size,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/tool') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let reqJson;
      try { reqJson = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); return; }
      const { tool, args = {}, timeoutMs } = reqJson;
      const t0 = Date.now();
      try {
        const data = await callTool(tool, args, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 300000));
        audit(`OK   ${tool} ${Date.now() - t0}ms`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        audit(`ERR  ${tool} ${Date.now() - t0}ms ${String(e && e.message).slice(0, 200)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.on('upgrade', (req, sock) => {
  if (!req.url || !req.url.startsWith('/ws')) { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  attachExtension(sock);
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[scrader-bridge] listening on http://127.0.0.1:${PORT}  (WS: /ws)`);
  });
}

module.exports = { server, callTool, encodeFrame, decodeFrames, _internals: { attachExtension, dropExtension } };
