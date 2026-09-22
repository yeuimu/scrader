// core/lib/router.js — 编排路由：工具请求 → 执行面（browser 桥 / cua 适配器 / decide 本地）
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { TOOLS_DEF } = require('./api');
const { mcpDecide } = require('./decide');
const { CFG_FILE } = require('./providers');
const { genHarvestCode } = require('../../hands/browser/harvest');
const { runCuaCall } = require('../../hands/cua/adapter');

const PORT = parseInt(process.env.SCRADER_PORT || '7827', 10);

// ── 浏览器桥 HTTP 客户端（bridge 住 hands/browser/bridge.js） ──
function req(method, urlPath, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, json: j, text: buf });
      });
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error('bridge 请求超时')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const bridgeStatus = () => req('GET', '/status', undefined, 3000);
const callBridge = (tool, args, timeoutMs) => req('POST', '/tool', { tool, args, timeoutMs });

async function ensureBridge() {
  try { await bridgeStatus(); return true; } catch {}
  console.error(`[scrader] bridge 未运行，自动拉起 hands/browser/bridge.js (:${PORT})`);
  const p = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hands', 'browser', 'bridge.js')], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, SCRADER_PORT: String(PORT) },
  });
  p.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await bridgeStatus(); return true; } catch {}
  }
  return false;
}

// ── 工具分发 ──
async function handleCall(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const def = TOOLS_DEF.find((t) => t.name === name);
  if (!def) return { content: [{ type: 'text', text: '未知工具: ' + name }], isError: true };

  // decide：脑在内核，不经过任何执行面
  if (name === 'decide') {
    let local = null, localErr = null;
    try { local = await mcpDecide(args); } catch (e) { localErr = (e && e.message) || String(e); }
    if (local) return { content: [{ type: 'text', text: JSON.stringify(local, null, 2) }] };
    const msg = localErr
      ? '决策链失败: ' + localErr
      : '决策提供方未配置：把模板 core/providers.example.json 复制为 ' + CFG_FILE + ' 并填入 Key，或设置 SCRADER_TYPESAFE_API_KEY / SCRADER_OPENROUTER_API_KEY / SCRADER_LLM_* 环境变量。';
    return { content: [{ type: 'text', text: msg }], isError: true };
  }

  // harvest：浏览器面专属代码生成，走 evaluate 通道
  if (name === 'harvest') {
    if (!args.itemSelector) return { content: [{ type: 'text', text: '缺少 itemSelector' }], isError: true };
    const r = await callBridge('evaluate', { tabId: args.tabId, code: genHarvestCode(args) }, 300000);
    const j = r.json || {};
    if (!j.ok) return { content: [{ type: 'text', text: 'harvest 失败: ' + (j.error || ('HTTP ' + r.status)) }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(j.data, null, 2) }] };
  }

  // desktop：cua 手（可选子系统）
  if (name === 'desktop') {
    const method = String(args.method || '');
    if (!/^[a-z_][a-z0-9_]*$/i.test(method)) return { content: [{ type: 'text', text: 'method 需为合法方法名（如 list_apps / get_window_state / click）' }], isError: true };
    try {
      const out = await runCuaCall(method, args.args && typeof args.args === 'object' ? args.args : {});
      return { content: [{ type: 'text', text: out || '(无输出)' }] };
    } catch (e) {
      const t = ((e && (e.stderr || e.stdout || e.message)) || String(e) || '').trim();
      return { content: [{ type: 'text', text: 'desktop 失败: ' + (t || '未知错误') }], isError: true };
    }
  }

  // 其余 → 浏览器桥
  const timeoutMs = name === 'evaluate' || name === 'wait_for' ? 300000 : 90000;
  let r;
  try {
    r = await callBridge(name, args, timeoutMs);
  } catch (e) {
    return { content: [{ type: 'text', text: '桥接不可达: ' + ((e && e.message) || e) + '（bridge.js 应已自动拉起，检查端口 ' + PORT + '）' }], isError: true };
  }
  const j = r.json || {};
  if (!j.ok) return { content: [{ type: 'text', text: String(j.error || ('HTTP ' + r.status)) }], isError: true };

  if (name === 'screenshot' && j.data && j.data.base64) {
    return { content: [{ type: 'image', data: j.data.base64, mimeType: j.data.mime || 'image/jpeg' }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(j.data, null, 2) }] };
}

module.exports = { PORT, req, callBridge, ensureBridge, handleCall };
