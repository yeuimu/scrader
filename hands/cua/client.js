// hands/cua/client.js — cua-driver 常驻 MCP 客户端（唯一实现；内核 desktop 工具与拟人执行器共用）
// 单次调用 ~6ms（168Hz 容量）；负责：连接、tools/call、重试、JSON 解析、光标读数、会话管理
'use strict';
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createClient({ session = 'gaze-demo', clientName = 'gaze-lib', callTimeoutMs = 45000 } = {}) {
  const child = spawn('cua-driver', ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  });
  child.stderr.on('data', () => {});
  function rpc(method, params, timeoutMs = callTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const raw = (name, args) => rpc('tools/call', { name, arguments: args })
    .then((r) => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.result; })
    .catch((e) => { throw new Error(name + ': ' + e.message); });

  const api = {
    session,
    sleep,
    async init() {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      // 建会话，并关闭"代理光标叠加层"（驱动默认开启，与真实指针叠影闪烁）
      await api.call('start_session', { session }).catch(() => {});
      await api.call('set_agent_cursor_enabled', { session, enabled: false }).catch(() => {});
    },
    // 失败默认重试一次（瞬态超时兜底）
    call(name, args, tries = 2) {
      return (async () => {
        for (let i = 1; ; i++) {
          try { return await raw(name, args); }
          catch (e) { if (i >= tries) throw e; await sleep(2000); }
        }
      })();
    },
    // MCP content/text → JS 对象（structuredContent 优先，兼容 ```json 围栏）
    parse(r) {
      if (r.structuredContent) return r.structuredContent;
      const t = r.content && r.content[0] && r.content[0].text;
      if (typeof t === 'string') {
        try { return JSON.parse(t); } catch (e) {
          const m = t.replace(/^```(json)?/, '').replace(/```\s*$/, '').trim();
          try { return JSON.parse(m); } catch (e2) { return { _text: t }; }
        }
      }
      return r;
    },
    // 真实光标位置 [x,y]（可能为负——窗口拖出屏幕左/上缘）
    async getPos() {
      const r = api.parse(await api.call('get_cursor_position', {}));
      if (r && typeof r.x === 'number' && typeof r.y === 'number') return [r.x, r.y]; // structuredContent 路径
      const m = /\((-?\d+),\s*(-?\d+)\)/.exec(JSON.stringify(r.content || r));        // 文本路径兜底
      return m ? [+m[1], +m[2]] : null;
    },
    async end() { child.kill(); },
  };
  return api;
}

module.exports = { createClient, sleep };
