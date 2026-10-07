#!/usr/bin/env node
// scripts/register.js — 把 scrader 注册进本机 agent（表驱动，installer 不含框架知识）
// 用法: node scripts/register.js --agent pi [--repo <源码目录>] [--home <用户目录>（默认 USERPROFILE）] [--list]
// 设计：cn-setup.ps1 只管依赖与源码（纯引导）；框架注册是框架知识，集中在本表——
// 新框架支持 = 加一行表项，不动安装器。JS 处理 JSON 无 PS5.1 数组解包一类的坑。
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// 各 agent 的注册知识（mcpFile 缺省 = 该宿主 MCP 配置位置不通用，只装技能并打印 JSON）
// 格式说明：pi / claude / cursor 的 MCP 配置都是 {mcpServers:{name:{command,args}}} —— mergeMcp 一种实现通吃。
const AGENTS = {
  pi: {
    label: 'pi',
    mcpFile: (h) => path.join(h, '.pi', 'agent', 'mcp.json'),
    skillsDir: (h) => path.join(h, '.pi', 'agent', 'skills', 'scrader'),
    detect: (h) => fs.existsSync(path.join(h, '.pi')),
  },
  zcode: {
    label: 'ZCode',
    skillsDir: (h) => path.join(h, '.zcode', 'skills', 'scrader'),
    detect: (h) => fs.existsSync(path.join(h, '.zcode')),
  },
  claude: {
    label: 'Claude Desktop',
    mcpFile: (h) => path.join(h, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    skillsDir: (h) => path.join(h, '.agents', 'skills', 'scrader'),
    detect: (h) => fs.existsSync(path.join(h, 'AppData', 'Roaming', 'Claude')),
  },
  cursor: {
    label: 'Cursor',
    mcpFile: (h) => path.join(h, '.cursor', 'mcp.json'),
    detect: (h) => fs.existsSync(path.join(h, '.cursor')),
  },
};

// ---- 纯函数（单测覆盖）----
// 幂等合并：已有 scrader 原样返回 {changed:false}；无则插入；解析失败返回 {backup:true} 由调用方落盘前备份
function mergeMcp(config, entry) {
  const next = JSON.parse(JSON.stringify(config || {}));
  if (!next.mcpServers || typeof next.mcpServers !== 'object') next.mcpServers = {};
  if (next.mcpServers.scrader) return { changed: false, config };
  next.mcpServers.scrader = entry;
  return { changed: true, config: next };
}

function mcpEntry(repo) {
  return { command: 'node', args: [path.join(repo, 'core', 'index.js')] };
}

function registerAgent(name, home, repo) {
  const a = AGENTS[name];
  if (!a) return { ok: false, note: `未知 agent "${name}"（--list 看支持列表）` };
  const out = { agent: a.label, mcp: null, skill: null };
  if (a.mcpFile) {
    const f = a.mcpFile(home);
    let raw = '{}';
    try { raw = fs.readFileSync(f, 'utf8'); } catch {}
    let cfg;
    try {
      cfg = JSON.parse(raw || '{}');
    } catch {
      fs.copyFileSync(f, f + '.bak');
      cfg = {};
      out.mcp = `解析失败，已备份 ${path.basename(f)}.bak，写入全新配置`;
    }
    const r = mergeMcp(cfg, mcpEntry(repo));
    if (r.changed) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(r.config, null, 2) + '\n');
      out.mcp = out.mcp || `已写入 ${f}`;
    } else out.mcp = '已注册（跳过，幂等）';
  }
  if (a.skillsDir) {
    const d = a.skillsDir(home);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(path.join(repo, 'skills', 'scrader'), d, { recursive: true });
    out.skill = `技能安装 ${d}`;
  }
  // 用户配置目录骨架：experiences/（站点经验笔记）+ sites/（守卫台账/学习缓存）一次到位
  try {
    const { userConfigDir } = require('../core/lib/providers');
    const cfg = userConfigDir();
    const expDir = path.join(cfg, 'experiences');
    fs.mkdirSync(expDir, { recursive: true });
    fs.mkdirSync(path.join(cfg, 'sites'), { recursive: true });
    const readme = path.join(expDir, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        '# 站点经验笔记（本机增量）',
        '',
        '每站一份 `<host>.md`（如 `www.temu.com.md`），记录：改版特征、按钮文案变体、风控行为。',
        '通用协议以 scrader 技能与 seeds 为准（随版本更新），这里只写本机新发现。',
        'harvest stats 的 `null_*` 突增 = 站点改版预警，先来这查笔记。',
        '',
      ].join('\n'));
    }
    out.userDirs = cfg;
  } catch {} // 骨架失败不影响注册
  if (!a.mcpFile) out.mcp = '（该宿主 MCP 配置位置随版本而异，不盲写——手工加: command=node, args=["<源码>/core/index.js"]）';
  return { ok: true, ...out };
}

function main() {
  const args = (() => { const o = {}; const a = process.argv.slice(2); for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1]; return o; })();
  const home = args.home || process.env.USERPROFILE || process.env.HOME;
  const repo = args.repo || REPO;
  if ('list' in args) {
    console.log(JSON.stringify({ agents: Object.keys(AGENTS), generic: mcpEntry(repo) }, null, 1));
    return 0;
  }
  if (!args.agent) { console.error('用法: node scripts/register.js --agent <pi|zcode|claude|cursor> [--home <dir>] [--repo <src>] [--list]'); return 1; }
  const r = registerAgent(args.agent, home, repo);
  console.log(JSON.stringify(r, null, 1));
  return r.ok ? 0 : 1;
}

module.exports = { mergeMcp, mcpEntry, registerAgent, AGENTS };
if (require.main === module) process.exit(main());
