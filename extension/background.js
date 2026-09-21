/**
 * scrader background service worker
 * ─────────────────────────────────────────────────────────────
 * 职责：
 *  1. 作为 WebSocket 客户端连接本地桥接进程 server/bridge.js（默认 127.0.0.1:7827）
 *  2. 接收桥接转发的工具调用（来自任意 Agent 的 MCP 请求），分发到
 *     chrome.tabs / chrome.scripting / chrome.debugger / 页面注入函数
 *     （决策 decide 在 MCP 服务器侧执行，密钥配置与扩展无关）
 *
 * 保活策略（MV3 service worker 会被杀）：
 *  - 每 20s 向桥接发 ping（Chrome 116+ WS 收发活动会重置空闲计时）
 *  - chrome.alarms 每 30s 兜底：发现连接断了就重连（alarm 能唤醒已死的 SW）
 */

const DEFAULTS = {
  port: 7827,
  allowlist: '*',
};

let ws = null;
let wsState = 'disconnected';
let pingTimer = null;
let reconnectTimer = null;
let lastAddr = '';

const log = (...a) => console.log('[scrader]', ...a);

function mergeCfg(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
      out[k] = mergeCfg(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}
async function getCfg() {
  const { scrader_cfg } = await chrome.storage.local.get('scrader_cfg');
  return mergeCfg(DEFAULTS, scrader_cfg || {});
}

// ───────────────────────────── 桥接连接 ─────────────────────────────

function connect() {
  getCfg().then((cfg) => {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    wsState = 'connecting';
    lastAddr = `127.0.0.1:${cfg.port}`;
    const sock = new WebSocket(`ws://${lastAddr}/ws`);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      wsState = 'connected';
      sock.send(JSON.stringify({ type: 'hello', name: 'scrader-extension', version: chrome.runtime.getManifest().version }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
      }, 20000);
      log('bridge connected', lastAddr);
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.type === 'tool') dispatch(msg);
    };
    sock.onclose = () => {
      if (ws === sock) { ws = null; wsState = 'disconnected'; }
      clearInterval(pingTimer);
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  }).catch((e) => log('connect failed', e && e.message));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.create('scrader-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'scrader-keepalive' && (!ws || ws.readyState > 1)) connect();
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.scrader_cfg) { try { ws && ws.close(); } catch {} connect(); }
});

async function dispatch(msg) {
  const { id, tool, args } = msg;
  let ok = true, data;
  try {
    data = await runTool(tool, args || {});
  } catch (e) {
    ok = false;
    data = String((e && e.message) || e);
  }
  try { ws && ws.send(JSON.stringify({ id, type: 'result', ok, data })); } catch (e) { log('reply failed', e && e.message); }
}

// ───────────────────────────── 通用工具函数 ─────────────────────────────

function globToRe(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}
async function assertAllowed(url) {
  const cfg = await getCfg();
  const list = String(cfg.allowlist || '*').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return;
  if (!list.some((p) => globToRe(p).test(url || ''))) {
    throw new Error(`页面不在 allowlist 内: ${url}（allowlist: ${cfg.allowlist}）`);
  }
}
async function resolveTab(tabId) {
  if (typeof tabId === 'number' && tabId > 0) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error(`标签页 ${tabId} 不存在`);
    return tabId;
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) throw new Error('找不到活动标签页');
  return t.id;
}

// eval 注入封装：func 序列化注入不受页面 CSP 影响，但内部 eval 受页面 CSP 约束，
// 被 CSP 拦截时自动降级 chrome.debugger（CDP Runtime.evaluate，不受 CSP 限制）
// eval 封装：含 return 的代码按函数体包裹，否则按表达式包裹（顶层 return 直接 eval 会报 Illegal return statement）
function wrapCode(src) {
  return /\breturn\b/.test(src) ? '(async()=>{\n' + src + '\n})()' : '(async()=>(\n' + src + '\n))()';
}

async function evalMain(tabId, code, world, useDebugger) {
  if (useDebugger) return cdpEval(tabId, code);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    world: world === 'isolated' ? 'ISOLATED' : 'MAIN',
    func: async (src) => {
      try {
        let v = (0, eval)(src);
        if (v && typeof v.then === 'function') v = await v;
        return { __ok: true, value: v === undefined ? null : v };
      } catch (e) {
        return { __ok: false, error: String((e && e.message) || e) };
      }
    },
    args: [wrapCode(String(code))],
  });
  const res = r && r.result;
  if (!res || typeof res !== 'object') throw new Error('evaluate 无返回（页面可能是 chrome:// 内部页或未加载完成）');
  if (!res.__ok && /Refused to evaluate|Unsafe eval|Content Security Policy|CSP/i.test(res.error || '')) {
    return cdpEval(tabId, code);
  }
  if (!res.__ok) throw new Error(res.error || 'evaluate failed');
  return res.value;
}

// ───────────────── 受信输入（chrome.debugger Input 域，isTrusted=true） ─────────────────
// 事件从浏览器输入管线产生，与真人无法区分；含拟人化：曲线鼠标轨迹、坐标抖动、
// 按压间隔、逐字符随机节奏键入。挂不上调试器（如 DevTools 占用）时由调用方降级合成事件。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.random() * (max - min);

let dbgChain = Promise.resolve();
function withDebugger(fn) { // 串行化调试器占用，避免 evaluate/受信输入并发 attach 冲突
  const p = dbgChain.then(fn);
  dbgChain = p.catch(() => {});
  return p;
}

async function attachDbg(tabId) {
  try { await chrome.debugger.attach({ tabId }, '1.3'); }
  catch (e) {
    if (!/already|another/i.test(String(e && e.message))) throw e;
    try { await chrome.debugger.detach({ tabId }); } catch {}
    await chrome.debugger.attach({ tabId }, '1.3');
  }
}

// 元素定位：selector 模式优先取视口内可见元素（哈希类可能被轮播克隆/离屏元素复用）；
// text 模式取精确文本叶子，优先带 role=button 祖先、其次最接近视口水平中心（过滤侧边栏同名链接）
async function getCenter(tabId, selector, text) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (sel, text) => {
      let el = null;
      if (sel) {
        const all = document.querySelectorAll(sel);
        if (all.length) {
          el = [...all].find((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.x >= 0 && r.x + r.width <= innerWidth && r.y >= 0 && r.y <= innerHeight; })
            || [...all].find((e) => e.getBoundingClientRect().height > 0)
            || all[0];
        }
      }
      if (!el && text) {
        const cx = innerWidth / 2;
        const rect = (e) => e.getBoundingClientRect();
        const leaves = [...document.querySelectorAll('div,span,button,a')]
          .filter((e) => (e.textContent || '').trim() === text && rect(e).height > 0 && rect(e).y >= 0 && rect(e).y < innerHeight);
        leaves.sort((a, b) => {
          const ra = a.closest && a.closest('[role="button"]') ? 0 : 1;
          const rb = b.closest && b.closest('[role="button"]') ? 0 : 1;
          if (ra !== rb) return ra - rb;
          return Math.abs(rect(a).x + rect(a).width / 2 - cx) - Math.abs(rect(b).x + rect(b).width / 2 - cx);
        });
        if (leaves.length) el = (leaves[0].closest && leaves[0].closest('[role="button"]')) || leaves[0];
      }
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const rect2 = el.getBoundingClientRect();
      const jx = (Math.random() - 0.5) * Math.max(1, rect2.width * 0.4);
      const jy = (Math.random() - 0.5) * Math.max(1, rect2.height * 0.4);
      return {
        x: Math.max(1, Math.round(rect2.x + rect2.width / 2 + jx)),
        y: Math.max(1, Math.round(rect2.y + rect2.height / 2 + jy)),
        vw: window.innerWidth, vh: window.innerHeight, tag: el.tagName,
      };
    },
    args: [selector ? String(selector) : null, text ? String(text) : null],
  });
  const res = r && r.result;
  if (!res || !res.x) throw new Error('selector not found: ' + (selector || 'text:' + text));
  return res;
}

// 贝塞尔曲线鼠标轨迹：带弧度、微抖动、先快后慢（ease-out）
async function humanMove(t, x0, y0, x1, y1) {
  const steps = Math.round(rnd(12, 22));
  const cx = (x0 + x1) / 2 + rnd(-60, 60);
  const cy = (y0 + y1) / 2 + rnd(-45, 45);
  for (let i = 1; i <= steps; i++) {
    const q = 1 - Math.pow(1 - i / steps, 2);
    const u = 1 - q;
    const x = Math.round(u * u * x0 + 2 * u * q * cx + q * q * x1 + rnd(-1.5, 1.5));
    const y = Math.round(u * u * y0 + 2 * u * q * cy + q * q * y1 + rnd(-1.5, 1.5));
    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(rnd(8, 18));
  }
}

// 拟人化移动+点击：从旁边一点带弧线移到目标，到位停顿，按下→抬起有人手间隔
async function humanClickAt(t, c, humanize) {
  if (humanize) {
    const sx = Math.max(5, Math.min(c.vw - 5, c.x + Math.round(rnd(120, 260)) * (Math.random() < 0.5 ? 1 : -1)));
    const sy = Math.max(5, Math.min(c.vh - 5, c.y + Math.round(rnd(-140, 140))));
    await humanMove(t, sx, sy, c.x, c.y);
    await sleep(rnd(40, 120));
  }
  await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  await sleep(humanize ? rnd(45, 110) : 20);
  await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
}

// 逐字符随机节奏键入（keyDown/text + keyUp），中文等多字节字符用 insertText
async function humanType(t, text) {
  for (const ch of String(text)) {
    if (/[^\x00-\x7F]/.test(ch)) {
      await chrome.debugger.sendCommand(t, 'Input.insertText', { text: ch });
    } else {
      const code = 'Key' + ch.toUpperCase();
      const vk = ch.toUpperCase().charCodeAt(0);
      const needShift = ch !== ch.toLowerCase() || /[!@#$%^&*()_+{}|:"<>?~]/.test(ch);
      const mods = needShift ? 8 : 0;
      await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', {
        type: 'keyDown', modifiers: mods, key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch,
      });
      await sleep(rnd(28, 90));
      await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', {
        type: 'keyUp', modifiers: mods, key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
    }
    await sleep(Math.random() < 0.08 ? rnd(200, 420) : rnd(25, 75)); // 偶尔"犹豫"
  }
}

async function trustedClick(tabId, selector, humanize, text) {
  return withDebugger(async () => {
    const c = await getCenter(tabId, selector, text);
    await attachDbg(tabId);
    try {
      await humanClickAt({ tabId }, c, humanize);
      return { ok: true, via: 'cdp-trusted', at: c.x + ',' + c.y };
    } finally { try { await chrome.debugger.detach({ tabId }); } catch {} }
  });
}

async function trustedFill(tabId, selector, value, humanize) {
  return withDebugger(async () => {
    const c = await getCenter(tabId, selector);
    await attachDbg(tabId);
    try {
      const t = { tabId };
      await humanClickAt(t, c, humanize); // 点击聚焦
      await sleep(humanize ? rnd(120, 260) : 50);
      // Ctrl+A 全选旧内容，键入替换
      await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await sleep(rnd(30, 70));
      await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await sleep(rnd(80, 180));
      await humanType(t, value);
      return { ok: true, via: 'cdp-trusted', typed: String(value).length };
    } finally { try { await chrome.debugger.detach({ tabId }); } catch {} }
  });
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 }, Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

async function trustedPress(tabId, key, humanize) {
  return withDebugger(async () => {
    await attachDbg(tabId);
    try {
      const t = { tabId };
      const spec = KEYMAP[key] || { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
      const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
      const down = { type: 'keyDown', ...base };
      if (spec.text) { down.text = spec.text; down.unmodifiedText = spec.text; }
      if (humanize) await sleep(rnd(30, 90));
      await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', down);
      await sleep(humanize ? rnd(55, 125) : 20);
      await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      return { ok: true, via: 'cdp-trusted' };
    } finally { try { await chrome.debugger.detach({ tabId }); } catch {} }
  });
}

// ───────────────── 受信拟人化滚动（滚轮事件序列） ─────────────────

// 页面滚动状态；sel=CSS选择器 或 text=精确文本 → 定位目标元素（虚拟列表重渲染时每次现查）
async function scrollState(tabId, sel, text) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (sel, text) => {
      let el = null;
      if (sel) { try { el = document.querySelector(sel); } catch {}
      }
      if (!el && text) {
        const leaves = [...document.querySelectorAll('div,span,button,a')].filter((e) => !e.childElementCount && e.getBoundingClientRect().height > 0);
        el = leaves.find((e) => (e.textContent || '').trim() === text) || leaves.find((e) => (e.textContent || '').includes(text));
      }
      const rect = el ? el.getBoundingClientRect() : null;
      return {
        scrollY: Math.round(window.scrollY), vh: window.innerHeight, vw: window.innerWidth,
        pageH: document.documentElement.scrollHeight,
        found: !!el, top: rect ? Math.round(rect.top) : null,
        inView: rect ? rect.top >= 0 && rect.top < window.innerHeight - 40 && rect.height > 0 : false,
      };
    },
    args: [sel ? String(sel) : null, text ? String(text) : null],
  });
  return r && r.result;
}

// 拟人化滚轮：每轮 2~4 档（每档 90~140px、间隔 25~85ms），轮间停顿 160~480ms，
// 5% 概率手滑回滚一格，鼠标位置缓慢漂移；untilText/untilSelector 出现在视口即停
async function trustedScroll(tabId, a) {
  return withDebugger(async () => {
    await attachDbg(tabId);
    try {
      const t = { tabId };
      const humanize = a.humanize !== false;
      const timeoutMs = Math.min(Number(a.timeoutMs) || 30000, 120000);
      const t0 = Date.now();
      const targetEl = !!(a.untilSelector || a.untilText);
      let st = await scrollState(tabId, a.untilSelector, a.untilText);
      if (!st) throw new Error('无法读取页面滚动状态');
      if (targetEl && st.found && st.inView) return { ok: true, via: 'cdp-trusted', alreadyInView: true, scrollY: st.scrollY };
      let goalY = null;
      if (!targetEl) {
        goalY = a.mode === 'to' ? (Number(a.y) || 0) : st.scrollY + (a.y === undefined ? Math.round(st.vh * 0.8) : Number(a.y));
      }
      let mx = Math.round(st.vw * (0.4 + Math.random() * 0.2));
      let my = Math.round(st.vh * (0.5 + Math.random() * 0.15));
      let lastY = -1, stagnant = 0, steps = 0;
      while (Date.now() - t0 < timeoutMs) {
        const notches = humanize ? Math.round(rnd(2, 4)) : 3;
        for (let i = 0; i < notches; i++) {
          await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: Math.max(1, mx), y: Math.max(1, my), button: 'none', deltaX: 0,
            deltaY: humanize ? Math.round(rnd(90, 140)) : 110,
          });
          steps++;
          if (humanize) {
            await sleep(rnd(25, 85));
            if (Math.random() < 0.05) {
              await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.max(1, mx), y: Math.max(1, my), button: 'none', deltaX: 0, deltaY: -Math.round(rnd(60, 100)) });
              await sleep(rnd(60, 140));
            }
          }
        }
        if (humanize) { mx += rnd(-12, 12); my += rnd(-8, 8); }
        await sleep(humanize ? rnd(160, 480) : 60);
        st = await scrollState(tabId, a.untilSelector, a.untilText);
        if (!st) throw new Error('滚动中读取页面状态失败');
        const atBottom = st.pageH - (st.scrollY + st.vh) < 5;
        if (targetEl) {
          if (st.found && st.inView) return { ok: true, via: 'cdp-trusted', found: true, inView: true, wheelSteps: steps, scrollY: st.scrollY, pageH: st.pageH };
          if (atBottom && Math.abs(st.scrollY - lastY) < 2) {
            if (++stagnant >= 2) return { ok: true, via: 'cdp-trusted', found: st.found, inView: false, wheelSteps: steps, scrollY: st.scrollY, pageH: st.pageH, note: '已滚到底部，目标未进入视口' };
          } else stagnant = 0;
        } else if (goalY !== null && (st.scrollY >= goalY - 4 || atBottom)) {
          return { ok: true, via: 'cdp-trusted', wheelSteps: steps, scrollY: st.scrollY, pageH: st.pageH, reached: st.scrollY >= goalY - 4 };
        }
        lastY = st.scrollY;
      }
      return { ok: true, via: 'cdp-trusted', timeout: true, wheelSteps: steps, scrollY: st.scrollY, pageH: st.pageH };
    } finally { try { await chrome.debugger.detach({ tabId }); } catch {} }
  });
}

async function cdpEval(tabId, code) {
  return withDebugger(async () => {
    await attachDbg(tabId);
    try {
      const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: wrapCode(String(code)), awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error(d || r.exceptionDetails.text || 'page exception');
      }
      return r.result ? r.result.value : null;
    } finally {
      try { await chrome.debugger.detach({ tabId }); } catch {}
    }
  });
}

// ───────────────────────────── 工具实现 ─────────────────────────────

const TOOLS = {
  status: async () => ({
    connected: wsState, addr: lastAddr,
    version: chrome.runtime.getManifest().version,
  }),

  list_tabs: async () =>
    (await chrome.tabs.query({})).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),

  open_tab: async (a) => {
    if (!a.url) throw new Error('缺少 url');
    const t = await chrome.tabs.create({ url: String(a.url), active: a.active !== false });
    return { tabId: t.id };
  },

  close_tab: async (a) => {
    if (typeof a.tabId !== 'number') throw new Error('缺少 tabId');
    await chrome.tabs.remove(a.tabId);
    return { closed: a.tabId };
  },

  activate_tab: async (a) => {
    const id = await resolveTab(a.tabId);
    await chrome.tabs.update(id, { active: true });
    return { ok: true };
  },

  navigate: async (a) => {
    if (!a.url) throw new Error('缺少 url');
    await assertAllowed(String(a.url));
    const id = await resolveTab(a.tabId);
    await chrome.tabs.update(id, { url: String(a.url) });
    return { ok: true, tabId: id };
  },

  evaluate: async (a) => {
    if (!a.code) throw new Error('缺少 code');
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    return evalMain(id, String(a.code), a.world, !!a.useDebugger);
  },

  read_page: async (a) => {
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: () => ({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 200000) }),
    });
    return r.result;
  },

  snapshot: async (a) => {
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: () => {
        const out = [];
        const SEL = 'a[href],button,input,select,textarea,[role],[contenteditable],[onclick]';
        for (const el of document.querySelectorAll(SEL)) {
          if (out.length >= 400) break;
          const rect = el.getBoundingClientRect();
          if (!rect.width && !rect.height) continue;
          const path = [];
          let n = el;
          while (n && n.nodeType === 1 && path.length < 6) {
            let s = n.tagName.toLowerCase();
            if (n.id) { path.unshift('#' + n.id); break; }
            const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
            if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
            path.unshift(s);
            n = n.parentElement;
          }
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80) || undefined,
            href: el.tagName === 'A' ? el.href : undefined,
            selector: path.join('>'),
          });
        }
        return { title: document.title, url: location.href, elements: out };
      },
    });
    return r.result;
  },

  click: async (a) => {
    if (!a.selector && !a.text) throw new Error('缺少 selector 或 text');
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    if (a.trusted !== false) {
      try { return await trustedClick(id, a.selector ? String(a.selector) : null, a.humanize !== false, a.text ? String(a.text) : null); }
      catch (e) {
        if (!a.selector) throw e; // 仅按 text 定位时没有合成事件降级路径
        log('受信点击失败，降级合成事件:', e && e.message);
      }
    }
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'selector not found: ' + sel };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
        try {
          el.dispatchEvent(new PointerEvent('pointerdown', o));
          el.dispatchEvent(new MouseEvent('mousedown', o));
          el.dispatchEvent(new PointerEvent('pointerup', o));
          el.dispatchEvent(new MouseEvent('mouseup', o));
          el.dispatchEvent(new MouseEvent('click', o));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      args: [String(a.selector)],
    });
    if (!r.result || !r.result.ok) throw new Error((r.result && r.result.error) || 'click failed');
    r.result.via = 'synthetic';
    return r.result;
  },

  fill: async (a) => {
    if (!a.selector || a.value === undefined) throw new Error('缺少 selector/value');
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    if (a.trusted !== false) {
      try { return await trustedFill(id, String(a.selector), String(a.value), a.humanize !== false); }
      catch (e) { log('受信输入失败，降级合成事件:', e && e.message); }
    }
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'selector not found: ' + sel };
        el.focus();
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      },
      args: [String(a.selector), String(a.value)],
    });
    if (!r.result || !r.result.ok) throw new Error((r.result && r.result.error) || 'fill failed');
    r.result.via = 'synthetic';
    return r.result;
  },

  press_key: async (a) => {
    if (!a.key) throw new Error('缺少 key');
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    if (a.trusted !== false) {
      try { return await trustedPress(id, String(a.key), a.humanize !== false); }
      catch (e) { log('受信按键失败，降级合成事件:', e && e.message); }
    }
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: (key) => {
        const el = document.activeElement || document.body;
        const map = {
          Enter: { key: 'Enter', code: 'Enter', keyCode: 13 }, Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
          Escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
          ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        };
        const spec = map[key] || { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
        const o = { bubbles: true, cancelable: true, composed: true, ...spec };
        el.dispatchEvent(new KeyboardEvent('keydown', o));
        el.dispatchEvent(new KeyboardEvent('keyup', o));
        return { ok: true, target: el.tagName, via: 'synthetic' };
      },
      args: [String(a.key)],
    });
    return r.result;
  },

  scroll: async (a) => {
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    if (a.trusted !== false) {
      try { return await trustedScroll(id, a); }
      catch (e) { log('受信滚动失败，降级合成滚动:', e && e.message); }
    }
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: (mode, x, y, behavior) => {
        const o = behavior === 'smooth' ? { behavior: 'smooth' } : {};
        if (mode === 'to') window.scrollTo({ top: y || 0, left: x || 0, ...o });
        else window.scrollBy({ top: y === undefined ? Math.round(innerHeight * 0.8) : y, left: x || 0, ...o });
        return { scrollY: window.scrollY, pageHeight: document.documentElement.scrollHeight };
      },
      args: [a.mode === 'to' ? 'to' : 'by', a.x ? Number(a.x) : 0, a.y === undefined ? undefined : Number(a.y), a.behavior],
    });
    return r.result;
  },

  wait_for: async (a) => {
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: async (sel, text, timeoutMs) => {
        const t0 = Date.now();
        for (;;) {
          if (sel && document.querySelector(sel)) return { found: true, match: 'selector', elapsed: Date.now() - t0 };
          if (text && (document.body ? document.body.innerText : '').includes(text)) return { found: true, match: 'text', elapsed: Date.now() - t0 };
          if (Date.now() - t0 >= timeoutMs) return { found: false, elapsed: Date.now() - t0 };
          await new Promise((res) => setTimeout(res, 250));
        }
      },
      args: [a.selector ? String(a.selector) : null, a.text ? String(a.text) : null, Number(a.timeoutMs) || 10000],
    });
    return r.result;
  },

  extract: async (a) => {
    if (!a.selector) throw new Error('缺少 selector');
    const id = await resolveTab(a.tabId);
    const t = await chrome.tabs.get(id);
    await assertAllowed(t.url);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id }, world: 'MAIN',
      func: (sel, fields, limit) => {
        const els = [...document.querySelectorAll(sel)].slice(0, limit || 500);
        return els.map((el) => {
          const row = { text: (el.innerText || '').trim() };
          const link = el.tagName === 'A' ? el : (el.closest ? el.closest('a') : null);
          if (link) row.href = link.href;
          if (fields) for (const name of Object.keys(fields)) {
            const s = el.querySelector(fields[name]);
            row[name] = s ? s.textContent.trim() : null;
          }
          return row;
        });
      },
      args: [String(a.selector), a.fields || null, a.limit ? Number(a.limit) : 500],
    });
    return r.result;
  },

  screenshot: async (a) => {
    const id = await resolveTab(a.tabId);
    const tab = await chrome.tabs.get(id);
    const fmt = a.format === 'png' ? 'png' : 'jpeg';
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: fmt, quality: 70 });
    return { mime: fmt === 'png' ? 'image/png' : 'image/jpeg', base64: dataUrl.split(',')[1] };
  },
};

async function runTool(name, args) {
  const f = TOOLS[name];
  if (!f) throw new Error('未知工具: ' + name);
  return f(args);
}
// ───────────────────────────── popup / options 消息 ─────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'scrader_status') { sendResp({ wsState, addr: wsState === 'connected' ? lastAddr : '' }); return; }
  if (msg.type === 'scrader_reconnect') { connect(); sendResp({ ok: true }); return; }
});

connect();
