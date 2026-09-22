// test-cua-smart.js — cua 智能层：parseCuaOut 解析容错（全平台）+ find_window（win32 实测，其余平台验降级）
// 不需要安装 cua-driver（find_window 只依赖 PowerShell）
'use strict';
const { parseCuaOut, findWindow } = require('../hands/cua/adapter');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✅ ' + name);
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

(async () => {
  // parseCuaOut：纯 JSON / ```json 围栏 / 非 JSON
  check('parseCuaOut 纯 JSON', JSON.stringify(parseCuaOut('{"ok":1}')) === '{"ok":1}');
  check('parseCuaOut 围栏 JSON', parseCuaOut('```json\n{"ok":2}\n```') && parseCuaOut('```json\n{"ok":2}\n```').ok === 2);
  check('parseCuaOut 非 JSON 返回 null', parseCuaOut('not json') === null);
  check('parseCuaOut 空输入返回 null', parseCuaOut('') === null && parseCuaOut(null) === null);

  // find_window
  const noTitle = JSON.parse(await findWindow({}));
  check('find_window 缺 title 报参数错', noTitle.ok === false && /title/.test(noTitle.error));

  if (process.platform === 'win32') {
    const r = JSON.parse(await findWindow({ title: 'Program Manager', exact: true }));
    check('find_window 枚举到窗口（scanned>0）', r.ok === true && r.scanned > 0, 'scanned=' + r.scanned);
    const m = (r.matches || [])[0];
    check('find_window 命中 Program Manager（hwnd 可作 window_id）', !!m && m.window_id > 0 && m.pid > 0, JSON.stringify(m).slice(0, 120));
    const zh = JSON.parse(await findWindow({ title: '不存在这个窗口xyz' }));
    check('find_window 无命中返回空数组', zh.ok === true && zh.matches.length === 0);
  } else {
    const r = JSON.parse(await findWindow({ title: 'x' }));
    check('find_window 非 Windows 优雅降级', r.ok === false && /Windows/.test(r.error));
  }

  console.log(failed === 0 ? '\n✅ cua 智能层测试全部通过' : `\n❌ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
