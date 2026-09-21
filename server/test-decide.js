/**
 * 直连决策 API 连通性测试（读用户配置目录 config.json，与 scrader-mcp 同一套查找逻辑）
 * 用法：node test-decide.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function userConfigDir() {
  if (process.env.SCRADER_CONFIG_DIR) return process.env.SCRADER_CONFIG_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'scrader_mcp');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'scrader_mcp');
}
const CFG_FILE = process.env.SCRADER_PROVIDERS || path.join(userConfigDir(), 'config.json');

async function main() {
  if (!fs.existsSync(CFG_FILE)) {
    console.log(`未找到配置：${CFG_FILE}\n把 server/providers.example.json 复制过去并填 Key`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  const order = (cfg.jevOrder || ['typesafe', 'openrouter']).filter((p) => cfg[p] && cfg[p].apiKey);
  if (!order.length) { console.log(`${CFG_FILE} 里没有任何 Jev Key`); process.exit(1); }
  for (const p of order) {
    const c = cfg[p];
    const headers = p === 'typesafe'
      ? { Authorization: 'Bearer ' + c.apiKey }
      : { Authorization: 'Bearer ' + c.apiKey, 'HTTP-Referer': 'https://github.com/chy4pro/scrader', 'X-Title': 'scrader' };
    const body = {
      model: c.model || 'jev-latest',
      state: { task: 'scrader 连通性测试：什么都不用做', page: { url: 'https://example.com/', text: '' } },
      questions: {
        q: { type: 'choice', criteria: { OK: '一切正常，选这个', RETRY: '有问题需要重试' }, instructions: { goal: '连通性测试，选择 OK' } },
        done: { type: 'noul', instructions: '任务是否已完成（应接近 1）' },
      },
    };
    const t0 = Date.now();
    try {
      const res = await fetch(c.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) { console.log(`❌ ${p} HTTP ${res.status}: ${text.slice(0, 300)}`); continue; }
      const j = JSON.parse(text);
      console.log(`✅ ${p} (${c.model}) HTTP 200, ${Date.now() - t0}ms`);
      console.log('   model 响应:', j.model);
      console.log('   answers:', JSON.stringify(j.answers));
      console.log('   usage:', JSON.stringify(j.usage));
      process.exit(0);
    } catch (e) {
      console.log(`❌ ${p} 连接失败: ${e.message}`);
    }
  }
  process.exit(1);
}
main();
