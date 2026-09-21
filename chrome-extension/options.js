// scrader 选项页：仅连接相关配置（端口/allowlist）；决策 Key 在 MCP 侧用户配置目录
const $ = (id) => document.getElementById(id);

async function load() {
  const { scrader_cfg = {} } = await chrome.storage.local.get('scrader_cfg');
  $('port').value = (scrader_cfg.port ?? 7827);
  $('allow').value = (scrader_cfg.allowlist ?? '*');
}

$('save').addEventListener('click', async () => {
  const cfg = {
    port: parseInt($('port').value, 10) || 7827,
    allowlist: $('allow').value.trim() || '*',
  };
  await chrome.storage.local.set({ scrader_cfg: cfg });
  $('msg').textContent = '✅ 已保存，扩展正在用新配置重连桥接…';
});

load();
