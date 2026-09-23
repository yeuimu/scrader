// hands/cua/adapter.js — cua-driver CLI 门面（desktop 工具实现）：UIA 读 + 真实输入
// 需本机另装 cua-driver。国内（推荐）：仓库 scripts/cn-setup.ps1（Gitee Release 镜像）；
// 海外官方（Windows PowerShell）：irm https://cua.ai/driver/install.ps1 | iex，再 cua-driver autostart kick。
// 未安装时给出指引；不影响 scrader 其余工具。浏览器操作仍走扩展本体，这里只补桌面原生应用。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

function execFileP(cmd, list, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, list, opts, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
  });
}

function resolveCuaDriver() {
  if (process.platform === 'win32') {
    const probe = spawnSync('where', ['cua-driver'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) {
      const first = (probe.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (first && !/\.cmd$/i.test(first)) return { cmd: first, shell: false };
    }
    const fb = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe');
    if (fb && fs.existsSync(fb)) return { cmd: fb, shell: false };
    return null;
  }
  const probe = spawnSync('which', ['cua-driver'], { encoding: 'utf8' });
  return probe.status === 0 ? { cmd: 'cua-driver', shell: false } : null;
}

async function runCuaCall(method, argsObj) {
  const cu = resolveCuaDriver();
  if (!cu) throw new Error('cua-driver 未安装 —— 桌面子系统未启用。国内安装：powershell -ExecutionPolicy Bypass -File scripts/cn-setup.ps1（Gitee 镜像）；海外官方：irm https://cua.ai/driver/install.ps1 | iex，然后 cua-driver autostart kick');
  const { stdout, stderr } = await execFileP(cu.cmd, ['call', method, JSON.stringify(argsObj || {})], { timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return ((stdout || '') + (stdout ? '' : (stderr || ''))).trim();
}

// ═══════════════════════════════════════════════════════════════════
// 智能层：把 Windows 原生窗口的实战铁律固化成默认行为
//  1) type_text 走 WM_CHAR 会吞反斜杠、合成组合键会泄漏裸键
//     → 原生控件文本一律 set_text（UIA set_value，不经键盘）
//  2) 写完必须回读校验再提交 → set_text = set_value + get_window_state 读回比对 + 重试一次
//  3) 对话框挂在每次都不同的宿主进程（pid 不可预测）
//     → find_window 按标题跨进程枚举全部顶层窗口；cua-driver 的 window_id 即 Win32 hwnd，可直接续用
//  4) 键盘类注入可能被 Windows 前台锁吞掉
//     → type_text/press_key/hotkey 自动先显式 bring_to_front（args.auto_front=false 关闭）
// ═══════════════════════════════════════════════════════════════════

const KEYBOARD_METHODS = new Set(['type_text', 'press_key', 'hotkey']);

// cua-driver call 的输出可能是纯 JSON 或 ```json 围栏文本
function parseCuaOut(out) {
  const t = String(out || '').trim().replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { return null; }
}

// PowerShell EnumWindows：跨进程列出全部可见顶层窗口（\x1f 分隔，规避标题中的引号/空格转义问题）
const PS_ENUM_WINDOWS = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ScraderWinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$sep = [char]31
$found = New-Object System.Collections.ArrayList
$cb = {
  param($h, $lp)
  if ([ScraderWinEnum]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][ScraderWinEnum]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t -ne '') {
      $p = 0
      [void][ScraderWinEnum]::GetWindowThreadProcessId($h, [ref]$p)
      $x = 0; $y = 0; $w = 0; $hh = 0
      try {
        $r = New-Object ScraderWinEnum+RECT
        [void][ScraderWinEnum]::GetWindowRect($h, [ref]$r)
        $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
      } catch {}
      [void]$found.Add(('{0}{7}{1}{7}{2}{7}{3}{7}{4}{7}{5}{7}{6}' -f $p, $h.ToInt64(), $x, $y, $w, $hh, $t, $sep))
    }
  }
  return $true
}
[ScraderWinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$found
`;

async function findWindow({ title, exact = false }) {
  if (!title) return JSON.stringify({ ok: false, error: '缺少 title（标题子串，不区分大小写）' });
  if (process.platform !== 'win32') return JSON.stringify({ ok: false, error: 'find_window 目前仅支持 Windows' });
  const encoded = Buffer.from(PS_ENUM_WINDOWS, 'utf16le').toString('base64');
  const { stdout } = await execFileP('powershell', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const sep = '\x1f';
  const wins = String(stdout || '').split(/\r?\n/).filter((l) => l.includes(sep)).map((l) => {
    const f = l.split(sep);
    return { pid: +f[0], window_id: +f[1], x: +f[2], y: +f[3], w: +f[4], h: +f[5], title: f.slice(6).join(sep) };
  }).filter((w) => Number.isFinite(w.window_id) && Number.isFinite(w.pid));
  const pat = String(title).toLowerCase();
  const matches = wins.filter((w) => (exact ? w.title.toLowerCase() === pat : w.title.toLowerCase().includes(pat)));
  return JSON.stringify({ ok: true, matches, scanned: wins.length }, null, 2);
}

// press_key 走 SendInput 真键码，反斜杠可存活（type_text 的 WM_CHAR 在部分输入法下吞 \）
// 大写经 press_key 会变小写，故仅安全字符集走 press_key，其余交给 type_text（回读校验兜底）
const SAFE_VK_CHARS = /^[a-z0-9 `\-=[\];',.\/\\]$/;

// 键盘兜底：置前 → 点元素聚焦 → 逐字符注入（\ 与安全符号走 press_key，其余 type_text）
async function typeViaKeyboard(pid, windowId, elementToken) {
  await runCuaCall('bring_to_front', { pid, window_id: windowId }).catch(() => {});
  await runCuaCall('click', { pid, window_id: windowId, element_token: elementToken }).catch(() => {});
}

async function setText({ pid, window_id, element_token, value, replace = true }) {
  if (!pid || !window_id || !element_token || typeof value !== 'string') {
    return JSON.stringify({ ok: false, error: '需要 pid / window_id / element_token / value' });
  }
  const expect = String(value);
  const readElements = async () => {
    const st = parseCuaOut(await runCuaCall('get_window_state', { pid, window_id, include_screenshot: false }));
    return (st && Array.isArray(st.elements)) ? st.elements : null;
  };
  const verify = async () => {
    let elements;
    try { elements = await readElements(); } catch (e) {
      throw new Error('回读失败（窗口可能已关闭）: ' + ((e && e.message) || e));
    }
    const hit = elements && elements.find((e) => e && e.value === expect);
    return hit || null;
  };

  // 路 1：UIA set_value（现代控件；文件对话框等）
  const svOut = await runCuaCall('set_value', { pid, window_id, element_token, value: expect });
  const sv = parseCuaOut(svOut);
  const refused = !sv || sv.status === 'refused' || /does not implement/i.test(svOut);
  let hit = null;
  try { hit = await verify(); } catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
  if (hit) return JSON.stringify({ ok: true, verified: true, via: 'uia_set_value', label: hit.label, role: hit.role });

  // 路 2：键盘兜底（经典控件无 ValuePattern；press_key 真键码可存活反斜杠）
  await typeViaKeyboard(pid, window_id, element_token);
  let observed = [];
  for (let pass = 1; pass <= 2; pass++) {
    if (replace) await runCuaCall('hotkey', { pid, window_id, keys: ['ctrl', 'a'] }).catch(() => {});
    for (const ch of expect) {
      if (ch === '\\' || SAFE_VK_CHARS.test(ch)) await runCuaCall('press_key', { pid, window_id, key: ch }).catch(() => {});
      else await runCuaCall('type_text', { pid, window_id, text: ch }).catch(() => {});
    }
    try { hit = await verify(); } catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
    if (hit) return JSON.stringify({ ok: true, verified: true, via: 'keyboard', pass, label: hit.label, role: hit.role });
    const els = await readElements().catch(() => null);
    observed = (els || []).filter((e) => typeof e.value === 'string' && e.value).slice(0, 3).map((e) => e.value.slice(0, 80));
  }
  return JSON.stringify({ ok: false, verified: false, refused, observed, error: 'set_value 与键盘兜底均未通过回读校验（observed 为控件当前值，供对照修正）' });
}

// desktop 工具入口：伪方法拦截 + 前台锁兜底，其余原样代理 cua-driver
async function runDesktop(method, args = {}) {
  if (method === 'find_window') return findWindow(args);
  if (method === 'set_text') return setText(args);
  if (KEYBOARD_METHODS.has(method) && args.pid && args.window_id && args.auto_front !== false) {
    await runCuaCall('bring_to_front', { pid: args.pid, window_id: args.window_id }).catch(() => {});
  }
  return runCuaCall(method, args);
}

module.exports = { resolveCuaDriver, runCuaCall, runDesktop, parseCuaOut, findWindow, setText };
