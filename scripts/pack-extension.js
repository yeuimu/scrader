// scripts/pack-extension.js — 扩展打包：dist/scrader-extension-<version>.zip
// 分发方式：解压 → chrome://extensions 开发者模式 → 加载已解压。
// 打包前强制校验 vendor 与 motion 一致，防止打出漂移产物。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'hands', 'browser', 'extension');
const DIST = path.join(ROOT, 'dist');
const VER = require(path.join(ROOT, 'package.json')).version;
const OUT = path.join(DIST, `scrader-extension-${VER}.zip`);

execFileSync(process.execPath, [path.join(__dirname, 'build-extension.js'), '--check'], { stdio: 'inherit' });

fs.mkdirSync(DIST, { recursive: true });
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path "${EXT}${path.sep}*" -DestinationPath "${OUT}"`], { stdio: 'inherit' });
} else {
  execFileSync('sh', ['-c', `cd "${EXT}" && zip -qr "${OUT}" .`], { stdio: 'inherit' });
}
console.log('已打包 ' + path.relative(ROOT, OUT) + ' (' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB)');
console.log('安装：解压 → chrome://extensions → 开发者模式 → 加载已解压的扩展程序');
