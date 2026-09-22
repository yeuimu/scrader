const $ = (id) => document.getElementById(id);
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'scrader_status' });
    const on = r && r.wsState === 'connected';
    $('dot').className = 'dot' + (on ? ' on' : '');
    $('st').textContent = on ? '已连接桥接 ' + (r.addr || '') : '未连接（bridge.js 未运行？）';
  } catch (e) {
    $('st').textContent = '状态未知: ' + (e.message || e);
  }
}
$('re').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'scrader_reconnect' }); setTimeout(refresh, 800); });
$('opt').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
refresh();
