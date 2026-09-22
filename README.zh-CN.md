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

## 安装

1. **扩展** —— `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `hands/browser/extension/`
2. **MCP 服务器** —— 任意 MCP 客户端配置加一条：
   ```json
   {
     "mcp": {
       "servers": {
         "scrader": {
           "command": "node",
           "args": ["<仓库路径>/core/index.js"]
         }
       }
     }
   }
   ```
   免克隆方式——`npx -y github:yeuimu/scrader`（Windows 客户端用 `cmd /c npx ...` 包装）。
3. **决策 Key**（可选，仅 `decide` 需要）—— 把 `core/providers.example.json` 复制为：
   - Windows：`%APPDATA%\scrader_mcp\config.json`
   - macOS / Linux：`~/.config/scrader_mcp/config.json`

重启 Agent 会话，工具以 `mcp__scrader__*` 出现。

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

`desktop` 代理本机 [cua-driver](https://github.com/trycua/cua) 守护进程（`cua-driver call <method> <json>`），补上原生桌面应用自动化——UIA 元素级点击，后台执行不抢焦点。安装（PowerShell）：`irm https://cua.ai/driver/install.ps1 | iex; cua-driver autostart kick`，装好即点亮；不装则优雅报错，不影响其他工具。浏览器页面操作仍走 scrader 本体的 DOM 级工具。

## 安全

桥接只监听 `127.0.0.1` · 密钥只存用户配置目录（永不入库）· 域名 allowlist（扩展选项页）· 审计日志 `SCRADER_LOG=<文件>`。

## 开发

```bash
node test/selftest.js  # 或 npm run selftest     # 全链路自测，无需 Chrome
node core/index.js --check
```

MIT
