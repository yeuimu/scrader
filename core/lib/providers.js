// core/lib/providers.js — 密钥/提供商配置（仅两级查找：SCRADER_PROVIDERS → 用户配置目录）
// 用户级配置目录（平台自适应）：SCRADER_CONFIG_DIR → Win:%APPDATA%\scrader_mcp → 其余:~/.config/scrader_mcp
// 目录内容：config.json（密钥）、experiences/（站点经验）、recipes/（站点配方）。包内零个人配置。
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

function loadProviders() {
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
  const pick = (a, b) => (b === undefined || b === null || b === '' ? a : b);
  const env = process.env;
  return {
    jevOrder: (env.SCRADER_JEV_ORDER ? env.SCRADER_JEV_ORDER.split(',').map((s) => s.trim()) : fileCfg.jevOrder) || ['typesafe', 'openrouter'],
    typesafe: {
      apiKey: pick(fileCfg.typesafe && fileCfg.typesafe.apiKey, env.SCRADER_TYPESAFE_API_KEY) || '',
      model: pick(pick('jev-latest', fileCfg.typesafe && fileCfg.typesafe.model), env.SCRADER_TYPESAFE_MODEL),
      endpoint: pick(pick('https://api.typesafe.ai/v1/systemone', fileCfg.typesafe && fileCfg.typesafe.endpoint), env.SCRADER_TYPESAFE_ENDPOINT),
    },
    openrouter: {
      apiKey: pick(fileCfg.openrouter && fileCfg.openrouter.apiKey, env.SCRADER_OPENROUTER_API_KEY) || '',
      model: pick(pick('typesafe/jev-1.13', fileCfg.openrouter && fileCfg.openrouter.model), env.SCRADER_OPENROUTER_MODEL),
      endpoint: pick(pick('https://openrouter.ai/api/alpha/decisions', fileCfg.openrouter && fileCfg.openrouter.endpoint), env.SCRADER_OPENROUTER_ENDPOINT),
    },
    llm: {
      baseUrl: pick(pick('', fileCfg.llm && fileCfg.llm.baseUrl), env.SCRADER_LLM_BASE_URL) || '',
      apiKey: pick(fileCfg.llm && fileCfg.llm.apiKey, env.SCRADER_LLM_API_KEY) || '',
      model: pick(pick('', fileCfg.llm && fileCfg.llm.model), env.SCRADER_LLM_MODEL) || '',
    },
  };
}

module.exports = { userConfigDir, CFG_FILE, loadProviders };
