// hands/act/site_cache.js — 站点能力缓存：知识放动作层（首触自动学习，跨任务复利）
// 层级：仓库种子 seeds/<host>.json（随发行，全站通用事实）← 用户层 <配置目录>/sites/<host>.json（本机学习覆盖）
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function sitesDir() {
  const base = process.env.SCRADER_CONFIG_DIR
    || (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'scrader_mcp')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'scrader_mcp'));
  return path.join(base, 'sites');
}
const seedPath = (host) => path.join(__dirname, 'seeds', host + '.json');
const userPath = (host) => path.join(sitesDir(), host + '.json');

function load(host) {
  let seed = {}, user = {};
  try { seed = JSON.parse(fs.readFileSync(seedPath(host), 'utf8')); } catch {}
  try { user = JSON.parse(fs.readFileSync(userPath(host), 'utf8')); } catch {}
  return { ...seed, ...user, host }; // 用户层覆盖种子
}

function save(host, patch) {
  const p = userPath(host);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  const next = { ...cur, ...patch, host, updated_at: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(next, null, 1));
  return next;
}

module.exports = { load, save, sitesDir, userPath };
