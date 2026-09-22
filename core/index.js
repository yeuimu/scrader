#!/usr/bin/env node
/**
 * scrader 内核入口（MCP stdio）—— 脑：Agent API + 决策 + 编排路由，零执行面代码
 * ─────────────────────────────────────────────────────────────
 * 任何支持 MCP 的 Agent（ZCode / Claude Desktop / Cursor / Cline …）通过它
 * 调用各执行面：浏览器（hands/browser，经本地 bridge）、桌面（hands/cua）。
 *
 * Agent 配置示例（ZCode workspace .zcode/config.json）：
 *   { "mcp": { "servers": { "scrader": {
 *       "command": "node",
 *       "args": ["C:/path/to/scrader/core/index.js"]
 *   } } } }
 * 环境变量：SCRADER_PORT（默认 7827，需与扩展选项页一致）
 * 版本唯一源：package.json
 */
'use strict';
const readline = require('readline');

const VERSION = require('../package.json').version;
const { TOOLS_DEF } = require('./lib/api');
const { userConfigDir, loadProviders } = require('./lib/providers');
const { ensureBridge, callBridge, handleCall } = require('./lib/router');
const { genHarvestCode } = require('../hands/browser/harvest');

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function startServer() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    const { id, method } = msg;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'scrader', title: 'scrader — browser ops & scraping bridge', version: VERSION },
        },
      });
      ensureBridge(); // 后台确保 bridge 在跑，不阻塞握手
      return;
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS_DEF } }); return; }
    if (method === 'tools/call') { send({ jsonrpc: '2.0', id, result: await handleCall(msg.params) }); return; }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  });
}

if (require.main === module) {
  // CLI: node core/index.js --check | --harvest '{"itemSelector":...}'
  if (process.argv.includes('--check')) {
    ensureBridge().then((ok) => {
      console.log(ok ? `bridge OK on :${process.env.SCRADER_PORT || 7827}` : `bridge FAILED`);
      process.exit(ok ? 0 : 1);
    });
  } else if (process.argv.includes('--harvest')) {
    const idx = process.argv.indexOf('--harvest');
    const args = JSON.parse(process.argv[idx + 1] || '{}');
    ensureBridge().then(async (ok) => {
      if (!ok) { console.error('bridge 不可达'); process.exit(1); }
      const r = await callBridge('evaluate', { tabId: args.tabId, code: genHarvestCode(args) }, 300000);
      const j = r.json || {};
      if (!j.ok) { console.error('harvest 失败:', j.error); process.exit(1); }
      const d = j.data || {};
      console.log(JSON.stringify({ stats: d.stats, items: d.items }, null, 2));
    }).catch((e) => { console.error(String(e)); process.exit(1); });
  } else {
    startServer();
  }
}

module.exports = { genHarvestCode, loadProviders, userConfigDir, TOOLS_DEF };
