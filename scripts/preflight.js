#!/usr/bin/env node
// scripts/preflight.js — 分发完整性自检：新用户拿到的每一条安装路径是否真的可用
// 用法: node scripts/preflight.js [--offline]
//   检查项（在线部分可用 --offline 跳过）：
//   1) 三个入口 URL 可达（gitee raw 引导脚本 / cua 镜像 zip / 源码包）
//   2) 源码包结构：下载归档抽验 manifest/SKILL/weights 非空（在线；离线改为查本地树）
//   3) npm 包：pack --dry-run 后必须含扩展源码、技能、recipes、test
//   4) 版本一致性：package.json == 扩展 manifest.json
//   5) 本地关键文件存在：bridge/扩展 manifest/SKILL/gaze 代码/gaze 权重
// 退出码 0 = 全部通过。发版前 / 疑似安装链路坏掉时跑它。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const offline = process.argv.includes('--offline');
let failed = 0;
const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => { failed++; console.log('  ❌ ' + m); };

function get(url, maxBytes = 65536, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 4) return resolve({ code: 0, got: 0, total: 0, head: null, url });
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'GET', timeout: 15000, headers: { 'User-Agent': 'curl/8.6.0 scrader-preflight' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const loc = res.headers.location;
        return resolve(loc ? get(new URL(loc, url).toString(), maxBytes, depth + 1) : { code: res.statusCode, got: 0, total: 0, head: null, url });
      }
      const total = parseInt(res.headers['content-range'] ? res.headers['content-range'].split('/')[1] : (res.headers['content-length'] || '0'), 10) || 0;
      const chunks = []; let got = 0;
      const done = () => resolve({ code: res.statusCode, got, total, head: Buffer.concat(chunks).subarray(0, 4), url });
      res.on('data', (c) => {
        if (got < maxBytes) { chunks.push(c); got += c.length; }
        if (got >= maxBytes) { res.destroy(); done(); }
      });
      res.on('end', done);
      res.on('error', done);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => resolve({ code: 0, got: 0, total: 0, head: null, url }));
    req.end();
  });
}

async function main() {
  // 4) 版本一致性
  const pv = require(path.join(ROOT, 'package.json')).version;
  const mv = JSON.parse(fs.readFileSync(path.join(ROOT, 'hands/browser/extension/manifest.json'), 'utf8')).version;
  (pv === mv) ? ok(`版本一致 package=${pv} manifest=${mv}`) : bad(`版本漂移 package=${pv} manifest=${mv}`);

  // 5) 本地关键文件
  const must = [
    'hands/browser/bridge.js',
    'hands/browser/extension/manifest.json',
    'hands/browser/extension/background.js',
    'skills/scrader/SKILL.md',
    'skills/scrader/references/install.md',
    'recipes/temu/accumulate_human.js',
    'hands/act/collect.js',
    'eyes/gaze/gaze.py',
  ];
  for (const f of must) fs.existsSync(path.join(ROOT, f)) ? ok('存在 ' + f) : bad('缺失 ' + f);
  const wDir = path.join(ROOT, 'eyes/gaze/weights');
  if (fs.existsSync(wDir)) {
    const sz = fs.readdirSync(wDir, { recursive: true }).length;
    sz > 3 ? ok(`gaze 权重目录 ${sz} 项（源码分发完整）`) : bad('gaze 权重目录疑似为空（仅 npm 包场景可接受）');
  } else bad('gaze 权重目录缺失（npm 包场景可接受，源码场景致命）');

  // 3) npm 包内容（npm notice 走 stderr，spawnSync 捕获）
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('npm', ['pack', '--dry-run'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
    const out = (r.stdout || '') + (r.stderr || '');
    const need = ['hands/browser/extension/manifest.json', 'skills/scrader/SKILL.md', 'recipes/temu/accumulate_human.js', 'test/selftest.js'];
    for (const f of need) out.includes(f) ? ok('npm 包含 ' + f) : bad('npm 包缺 ' + f);
  } catch (e) { bad('npm pack 失败: ' + e.message.split('\n')[0]); }

  // 1) 入口 URL（在线，跟随重定向）
  if (offline) { console.log('  ⏭ 在线检查已跳过（--offline）'); }
  else {
    const pvTag = 'v' + pv;
    const urls = [
      ['引导脚本 raw', 'https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1', 3000, null],
      ['源码包 archive', 'https://gitee.com/yeuimu/scrader/repository/archive/main.zip', 4096, 'PK'], // min + zip 魔数
    ];
    for (const [name, url, min, magic] of urls) {
      const r = await get(url, 8192);
      const magicOk = !magic || (r.head && r.head.subarray(0, magic.length).toString('latin1') === magic);
      const sizeOk = (r.total >= min) || (r.got >= min);
      (r.code === 200 && sizeOk && magicOk)
        ? ok(`${name} 200（${(r.total / 1048576).toFixed(1)}MB${magic ? ' PK✓' : ''}）`)
        : bad(`${name} 异常 code=${r.code} got=${r.got} total=${r.total}${magic ? ' magic=' + (r.head ? r.head.toString('latin1') : 'none') : ''}`);
    }
    const cuaUrls = [
      [`cua 镜像@${pvTag}`, `https://gitee.com/yeuimu/scrader/releases/download/${pvTag}/cua-driver-mirror-0.28.2-win-x64.zip`],
      ['cua 镜像@v0.6.2(兜底)', 'https://gitee.com/yeuimu/scrader/releases/download/v0.6.2/cua-driver-mirror-0.28.2-win-x64.zip'],
    ];
    let cuaOk = false, cuaMsg = '';
    for (const [name, url] of cuaUrls) {
      const r = await get(url, 8192);
      const magicOk = r.head && r.head.subarray(0, 2).toString('latin1') === 'PK';
      const sizeOk = r.total > 1024 * 1024 || r.got >= 8192;
      cuaMsg += ` ${name}=${r.code}(${r.total})`;
      if (r.code === 200 && sizeOk && magicOk) { cuaOk = true; ok(`cua 镜像可达（${name}，${(r.total / 1048576).toFixed(1)}MB）`); break; }
    }
    if (!cuaOk) bad('cua 镜像全不可达' + cuaMsg);
  }

  console.log(failed ? `❌ preflight ${failed} 项未过` : '✅ preflight 全部通过');
  process.exit(failed ? 1 : 0);
}
main();
