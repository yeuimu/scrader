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

- **18 个 MCP 工具** —— 标签页、页面读取、`evaluate`（任意 JS）、截图 …
- **受信拟人化输入** —— click / fill / scroll 走 `chrome.debugger`（`isTrusted=true`），贝塞尔轨迹、坐标抖动、逐字符节奏键入；失败自动降级合成事件
- **`harvest` 通用采集** —— 抗虚拟列表滚动、stableId 合并去重、二遍补采、图片规范化
- **`decide` 快速决策**（可选）—— Jev：TypeSafe 官方 → OpenRouter → 任意 OpenAI 兼容 LLM 兜底
- **不开 CDP 9222 端口** —— 永远不会弹"允许外部调试"同意框

## 架构

```
Agent (MCP stdio) ── core/index.js ── HTTP 127.0.0.1:7827 ── bridge.js ── WebSocket ── Chrome 扩展 (MV3)
```

扩展只管浏览器；bridge 不在运行时自动拉起。

## 安装（两阶段：极简引导 → agent 自主完成）

**阶段 1 · 极简引导**（人类执行一次，只装三样——Node≥18 / 技能 / cua-driver，全国内源）：
```
irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
```
`-DryRun` 可演练；安装器零框架知识，结尾只打印一行指引。

**阶段 2 · agent 自主完成**（用户说「按 scrader 技能完成安装」即触发）：按技能 `references/install.md` runbook——注册 MCP 进本宿主（`node scripts/register.js --agent pi`，表驱动）→ 重连 → **cua 自动加载浏览器扩展**（chrome://extensions → 开发者模式 → 加载已解压 → 文件对话框 set_text 路径——不再有手工浏览器步骤）→ 全链路验证；可选项（gaze 依赖/decide 密钥/npm 源）按需自装。

免引导备选：国内 `npx -y git+https://gitee.com/yeuimu/scrader.git`（海外 `npx -y github:yeuimu/scrader`），然后任意 MCP 客户端配置 `{"command":"node","args":["<仓库>/core/index.js"]}`。

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
    { key: 'price',     pattern: '(\\d[\\d,]*)円', kind: 'int' },
    { key: 'soldCount', pattern: '已售([\\d,.]+[万K]?)件' },
  ],
})
// → { items: [...], stats: { count, null_price, uniqueImages, … } }
```

`stats.null_*` 突增 = 站点改版预警，查配置目录 `experiences/` 笔记。

## 桌面应用（可选）

`desktop` 代理本机 [cua-driver](https://github.com/trycua/cua) 守护进程（`cua-driver call <method> <json>`），补上原生桌面应用自动化——UIA 元素级点击，后台执行不抢焦点。内置智能方法：`find_window({title})` 按标题跨进程找窗口（对话框宿主 pid 每次都变，别只查已知 pid）；`set_text({pid,window_id,element_token,value})` 原生控件写文本（UIA set_value → 键盘兜底，反斜杠安全，自动回读校验）；键盘类方法自动先 bring_to_front 兜前台锁。安装（PowerShell，国内镜像优先）：仓库内 `powershell -ExecutionPolicy Bypass -File scripts\cn-setup.ps1`（cua-driver 走 Gitee Release 镜像，官方 cua.ai 安装包的 MIT 原样转存）；或官方渠道（海外）`$env:CUA_DRIVER_RS_VERSION="0.28.2"; irm https://cua.ai/driver/install.ps1 | iex; cua-driver autostart kick`，装好即点亮；不装则优雅报错，不影响其他工具。浏览器页面操作仍走 scrader 本体的 DOM 级工具。

## 安全

桥接只监听 `127.0.0.1` · 密钥只存用户配置目录（永不入库）· 域名 allowlist（扩展选项页）· 审计日志 `SCRADER_LOG=<文件>`。

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
2) 按 ~/.agents/skills/scrader/ 的技能完成剩余安装（references/install.md runbook）：
   注册 MCP 进你的宿主（node <源码>/scripts/register.js --agent <pi|zcode> 或按宿主格式手配）→ 重连会话
   → 用 cua 自动加载浏览器扩展（chrome://extensions → 开发者模式 → 加载已解压 → 文件对话框 set_text
     <源码>\hands\browser\extension 绝对路径；对话框宿主 pid 每次变，find_window 现找；set_text 反斜杠安全）
   → 验证：status 扩展已连接 / read_page 任一页面 / desktop list_apps。
3) 可选（问我要不要）：decide 密钥（core/providers.example.json → %APPDATA%/scrader_mcp/config.json，
   llm 兜底可填 DeepSeek/GLM）；gaze 视觉依赖（uv 或 venv+清华源）。
逐步执行；每步给我证据。完成后按 skills/scrader/SKILL.md 的决策树与铁律使用。
```
