// hands/cua/adapter.js — cua-driver CLI 门面（desktop 工具实现）：UIA 读 + 真实输入
// 需本机另装 cua-driver（Windows PowerShell：irm https://cua.ai/driver/install.ps1 | iex，
// 再 cua-driver autostart kick）。未安装时给出指引；不影响 scrader 其余工具。
// 浏览器操作仍走扩展本体，这里只补桌面原生应用。
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
  if (!cu) throw new Error('cua-driver 未安装 —— 桌面子系统未启用。安装（Windows PowerShell）：irm https://cua.ai/driver/install.ps1 | iex，然后 cua-driver autostart kick；详见 https://cua.ai/docs/tutorials/drive-your-first-app');
  const { stdout, stderr } = await execFileP(cu.cmd, ['call', method, JSON.stringify(argsObj || {})], { timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return ((stdout || '') + (stdout ? '' : (stderr || ''))).trim();
}

module.exports = { resolveCuaDriver, runCuaCall };
