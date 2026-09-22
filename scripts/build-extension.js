// scripts/build-extension.js — 扩展构建步骤：motion/trajectory.js（唯一源）→ 扩展可用的 vendor 文件
// 用法：node scripts/build-extension.js          生成 hands/browser/extension/vendor/trajectory.js
//       node scripts/build-extension.js --check  CI 断言：产物与源头一致（防手改产物/忘跑构建）
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'motion', 'trajectory.js');
const OUT = path.join(__dirname, '..', 'hands', 'browser', 'extension', 'vendor', 'trajectory.js');

function build() {
  let src = fs.readFileSync(SRC, 'utf8');
  if (/require\(/.test(src)) throw new Error('motion/trajectory.js 出现 require —— 构建脚本需增加剥离规则');
  src = src.replace(/module\.exports = [^;]+;/, '');
  const header = '// ⚠️ 构建产物：由 scripts/build-extension.js 从 motion/trajectory.js 生成，勿手改。\n'
    + '// 改算法请编辑 motion/trajectory.js 后运行 npm run build:extension 并重载扩展。\n';
  return header + src;
}

if (process.argv.includes('--check')) {
  const want = build();
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (want === have) { console.log('vendor/trajectory.js 与 motion 一致 ✓'); process.exit(0); }
  console.error('vendor/trajectory.js 与 motion/trajectory.js 不一致 —— 运行 npm run build:extension');
  process.exit(1);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, build());
  console.log('已生成 ' + path.relative(path.join(__dirname, '..'), OUT));
}
