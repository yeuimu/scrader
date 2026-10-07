<p align="center"><img src="hands/browser/extension/icons/icon128.png" width="96" alt="scrader 图标"></p>

# scrader

**S**pider + sc**r**aper —— 把浏览器操作与网页抓取封装成 [MCP](https://modelcontextprotocol.io) 工具，供任意 AI Agent（ZCode / Claude Desktop / Cursor / Cline …）直接调用。

[English](README.md)

## Layout

```
core/  brain: MCP API + decide + routing
hands/ effectors: browser(extension+bridge+harvest) / cua(client+adapter+glide)
eyes/  gaze: screenshot → YOLO+OCR → elements
motion/ humanized trajectory (single source, dual backends)
docs/ARCHITECTURE.md for details
```

## 特性

- **19 个 MCP 工具** —— 标签页、页面读取、`evaluate`（任意 JS）、截图、`desktop`（UIA 桌面自动化）…
- **受信拟人化输入** —— click / fill / scroll 走 `chrome.debugger`（`isTrusted=true`），贝塞尔轨迹、坐标抖动、逐字符节奏键入；失败自动降级合成事件
- **`harvest` 通用采集** —— 抗虚拟列表滚动、stableId 合并去重、二遍补采、图片规范化
- **act 意图动词层** —— open_item / read_scroll / click_verified 等"说意图不拼坐标"，先零输入演练后执行，站点能力自动学习入库（seeds + 用户层）
- **反封锁守卫 + 六步采集协议** —— `collect.js` 一条命令代码级强制：闸门→封锁签名→温启→限额→拟人滚采→验收记账（日限/冷却可配）
- **双浏览器并行** —— Chrome / Edge 各装一份扩展也不打架：bridge 按 UA 区分客户端、调用自动路由
- **agent 技能分发** —— 安装/使用/站点知识随包分发（SKILL.md + references），新 agent 零提示上手
- **`decide` 快速决策**（可选）—— Jev：TypeSafe 官方 → OpenRouter → 任意 OpenAI 兼容 LLM 兜底
- **不开 CDP 9222 端口** —— 永远不会弹"允许外部调试"同意框

> **平台支持**：Windows 10/11 全功能（引导脚本、cua 桌面自动化为 Windows 专属）。macOS / Linux 可跑浏览器面（bridge + 扩展），桌面自动化暂不支持。

## 架构

```
Agent (MCP stdio) ── core/index.js ── HTTP 127.0.0.1:7827 ── bridge.js ── WebSocket ── Chrome/Edge 扩展 (MV3)
```

扩展只管浏览器；bridge 若未运行，首次调用时自动拉起（进程意外退出也会自动复活）。

## 安装（两阶段：极简引导 → agent 自主完成）

**阶段 1 · 极简引导**（人类执行一次，只装三样——Node≥18 / 技能 / cua-driver，全国内源）：
```
irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
```
`-DryRun` 可演练；安装器零框架知识，结尾只打印一行指引。

**阶段 2 · agent 自主完成**（用户说「按 scrader 技能完成安装」即触发）：按技能 `references/install.md` runbook——注册 MCP 进本宿主（`node scripts/register.js --agent pi`，表驱动）→ 重连 → **cua 自动加载浏览器扩展**（chrome://extensions → 开发者模式 → 加载未打包的扩展程序 → 文件对话框 set_text 路径——不再有手工浏览器步骤）→ 全链路验证；可选项（gaze 依赖/decide 密钥/npm 源）按需自装。源码位置已写入 `~/.agents/skills/scrader/source-path.txt`，agent 自动定位。

免引导备选（任意 MCP 客户端配置）：国内 `npx -y git+https://gitee.com/yeuimu/scrader.git`，海外 `npx -y github:yeuimu/scrader`：
```json
{ "mcp": { "servers": { "scrader": { "command": "node", "args": ["<包内 core/index.js 路径>"] } } } }
```
npm 包含扩展源码（`hands/browser/extension/`）与全部脚本；仅 gaze 权重（93MB）不在包内——需要视觉感知时从 [Gitee Release](https://gitee.com/yeuimu/scrader/releases) 下载 `gaze-weights-*.zip` 解压到 `eyes/gaze/weights/`，或从[源码包](https://gitee.com/yeuimu/scrader/repository/archive/main.zip)（含全部权重）里只抽 `eyes/gaze/weights/`。

## 工具

| 类别 | 工具 |
|---|---|
| 标签页 | `status` `list_tabs` `open_tab` `close_tab` `activate_tab` `navigate` |
| 读取 | `read_page` `snapshot` `extract` `screenshot` |
| 操作 | `evaluate` `click` `fill` `press_key` `scroll` `wait_for` |
| 采集/决策 | `harvest` `decide` |
| 桌面（可选） | `desktop` |

### harvest 示例

```js
harvest({
  itemSelector: 'a[href*="-g-"]',   // Temu 商品卡片
  maxItems: 200,
  fields: [
    { key: 'price',     pattern: '(\\d[\\d,]*)円' },
    { key: 'soldCount', pattern: '已售([\\d,.]+[万K]?)件|([\\d,.]+[万K]?)販売' },  // 同站多 locale 用 | 双语正则
  ],
})
// → { items: [...], stats: { count, null_price, uniqueImages, … } }
```

`stats.null_*` 突增 = 站点改版预警，查配置目录 `experiences/` 笔记。

## 桌面应用（可选）

`desktop` 代理本机 [cua-driver](https://github.com/trycua/cua) 守护进程（`cua-driver call <method> <json>`），补上原生桌面应用自动化——UIA 元素级点击，后台执行不抢焦点。内置智能方法：`find_window({title})` 按标题跨进程找窗口（对话框宿主 pid 每次都变，别只查已知 pid）；`set_text({pid,window_id,element_token,value})` 原生控件写文本（UIA set_value → 键盘兜底，反斜杠安全，自动回读校验）；键盘类方法自动先 bring_to_front 兜前台锁。安装（PowerShell，国内镜像优先）：仓库内 `powershell -ExecutionPolicy Bypass -File scripts\cn-setup.ps1`（cua-driver 走 Gitee Release 镜像，官方 cua.ai 安装包的 MIT 原样转存）；或官方渠道（海外）`$env:CUA_DRIVER_RS_VERSION="0.28.2"; irm https://cua.ai/driver/install.ps1 | iex; cua-driver autostart kick`，装好即点亮；不装则优雅报错，不影响其他工具。浏览器页面操作仍走 scrader 本体的 DOM 级工具。

## 安全

桥接只监听 `127.0.0.1` · 密钥只存用户配置目录（永不入库）· 域名 allowlist（扩展选项页，默认 `*` 不限制，可收敛为站点白名单）· 审计日志 `SCRADER_LOG=<文件>`。

## 卸载

`powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1`（`-DryRun` 演练；`-RemoveData` 连用户数据一起删；扩展与宿主 mcp.json 两个手工步骤见脚本输出）。

## 开发

```bash
node test/selftest.js  # 或 npm run selftest     # 全链路自测，无需 Chrome
node core/index.js --check
```

MIT

## Agent 安装使用

> 把下面的提示词发给任何支持 MCP 的 Agent。技能 runbook（`skills/scrader/references/install.md`）里有完整的 agent 自主安装步骤——含用 cua 自动加载浏览器扩展。

```text
请在本机安装并配置 scrader（通用浏览器/桌面控制器；全部走国内源）：
1) 极简引导（只装 Node≥18 / 技能 / cua-driver 三样，PowerShell）：
   irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
2) 按 ~/.agents/skills/scrader/ 的技能完成剩余安装（references/install.md runbook；
   源码位置读同目录 source-path.txt）：
   注册 MCP 进你的宿主（node <源码>/scripts/register.js --agent <pi|zcode> 或按宿主格式手配）→ 重连会话
   → 用 cua 自动加载浏览器扩展（chrome://extensions → 开发者模式 → 加载未打包的扩展程序 → 文件对话框
     set_text <源码>\hands\browser\extension 绝对路径；对话框宿主 pid 每次变，find_window 现找；set_text 反斜杠安全）
   → 验证：status 扩展已连接 / read_page 任一页面 / desktop list_apps。
3) 可选（问我要不要）：decide 密钥（core/providers.example.json → %APPDATA%/scrader_mcp/config.json，
   llm 兜底可填 DeepSeek/GLM）；gaze 视觉依赖（uv 或 venv+清华源）。
逐步执行；每步给我证据。完成后按 skills/scrader/SKILL.md 的决策树与铁律使用。
```
