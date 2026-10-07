// test/test-register.js — register.js 注册器单测：合并/幂等/args 数组/技能安装（临时 HOME）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { mergeMcp, mcpEntry, registerAgent } = require('../scripts/register');

let n = 0;
const ok = (m) => { n++; console.log('  ✅ ' + m); };

// ── mergeMcp 纯函数 ──
{
  const entry = { command: 'node', args: ['C:/x/core/index.js'] };
  // 空配置 → 插入
  const r1 = mergeMcp({}, entry);
  assert.ok(r1.changed && r1.config.mcpServers.scrader.args.length === 1);
  assert.ok(Array.isArray(r1.config.mcpServers.scrader.args), 'args 必须是数组（PS5.1 解包坑的 JS 对应断言）');
  // 已有其他 server → 合并保留
  const r2 = mergeMcp({ mcpServers: { other: { command: 'foo' } } }, entry);
  assert.ok(r2.changed && r2.config.mcpServers.other && r2.config.mcpServers.scrader);
  // 已有 scrader → 幂等跳过，原对象不动
  const orig = { mcpServers: { scrader: { command: 'old' } } };
  const r3 = mergeMcp(orig, entry);
  assert.ok(!r3.changed && r3.config.mcpServers.scrader.command === 'old');
  ok('mergeMcp 合并保留/幂等跳过/args 数组');
}

// ── registerAgent 全流程（临时 HOME + 真 mcp.json + 技能拷贝）──
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'foo', args: ['x'] } } }));
  const repo = path.resolve(__dirname, '..');
  const r1 = registerAgent('pi', home, repo);
  assert.ok(r1.ok && /已写入/.test(r1.mcp) && r1.skill);
  const m = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'mcp.json'), 'utf8'));
  assert.ok(m.mcpServers.other, '现有 server 必须保留');
  assert.ok(Array.isArray(m.mcpServers.scrader.args), 'args 数组');
  assert.ok(fs.existsSync(path.join(home, '.pi', 'agent', 'skills', 'scrader', 'SKILL.md')), '技能落位');
  // 幂等：二跑不改动
  const before = fs.readFileSync(path.join(home, '.pi', 'agent', 'mcp.json'), 'utf8');
  const r2 = registerAgent('pi', home, repo);
  assert.ok(/幂等/.test(r2.mcp));
  assert.strictEqual(fs.readFileSync(path.join(home, '.pi', 'agent', 'mcp.json'), 'utf8'), before, '二跑文件逐字节不变');
  // 损坏 JSON → 备份兜底
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'mcp.json'), '{broken');
  const r3 = registerAgent('pi', home, repo);
  assert.ok(r3.ok && /备份/.test(r3.mcp));
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'mcp.json'), 'utf8')).mcpServers.scrader);
  // zcode：只装技能不写 mcp
  const z = registerAgent('zcode', home, repo);
  assert.ok(z.ok && z.skill && /不盲写/.test(z.mcp) && !fs.existsSync(path.join(home, '.zcode', 'mcp.json')));
  // claude：写 claude_desktop_config.json（{mcpServers} 同构）+ 技能装到 ~/.agents
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'Claude'), { recursive: true });
  fs.writeFileSync(path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), '{"globalShortcut":""}');
  const c = registerAgent('claude', home, repo);
  assert.ok(c.ok && /已写入/.test(c.mcp), 'claude 写入 mcp');
  const cc = JSON.parse(fs.readFileSync(path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), 'utf8'));
  assert.ok(cc.globalShortcut === '' && Array.isArray(cc.mcpServers.scrader.args), 'claude 保留原字段 + args 数组');
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'scrader', 'SKILL.md')), 'claude 技能落位');
  // cursor：写 ~/.cursor/mcp.json，无技能目录约定
  const cu = registerAgent('cursor', home, repo);
  assert.ok(cu.ok && /已写入/.test(cu.mcp), 'cursor 写入 mcp');
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(Array.isArray(cj.mcpServers.scrader.args), 'cursor args 数组');
  // 未知 agent 拒绝
  assert.ok(!registerAgent('nope', home, repo).ok);
  fs.rmSync(home, { recursive: true, force: true });
  ok('registerAgent 全流程（合并/幂等/损坏兜底/zcode 只技能/claude+cursor/未知拒绝）');
}

console.log(`✅ register 注册器 ${n} 组断言全部通过`);
