<p align="center"><img src="chrome-extension/icons/icon128.png" width="96" alt="scrader 图标"></p>

# scrader

**S**pider + sc**r**aper —— 把浏览器操作与网页抓取封装成 [MCP](https://modelcontextprotocol.io) 工具，供任意 AI Agent（ZCode / Claude Desktop / Cursor / Cline …）直接调用。

[English](README.md)

## 特性

- **18 个 MCP 工具** —— 标签页、页面读取、`evaluate`（任意 JS）、截图 …
- **受信拟人化输入** —— click / fill / scroll 走 `chrome.debugger`（`isTrusted=true`），贝塞尔轨迹、坐标抖动、逐字符节奏键入；失败自动降级合成事件
- **`harvest` 通用采集** —— 抗虚拟列表滚动、stableId 合并去重、二遍补采、图片规范化
- **`decide` 快速决策**（可选）—— Jev：TypeSafe 官方 → OpenRouter → 任意 OpenAI 兼容 LLM 兜底
- **不开 CDP 9222 端口** —— 永远不会弹"允许外部调试"同意框

## 架构

```
Agent (MCP stdio) ── scrader-mcp.js ── HTTP 127.0.0.1:7827 ── bridge.js ── WebSocket ── Chrome 扩展 (MV3)
```

扩展只管浏览器；bridge 不在运行时自动拉起。

## 安装

1. **扩展** —— `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `chrome-extension/`
2. **MCP 服务器** —— 任意 MCP 客户端配置加一条：
   ```json
   {
     "mcp": {
       "servers": {
         "scrader": {
           "command": "node",
           "args": ["<仓库路径>/mcp-server/scrader-mcp.js"]
         }
       }
     }
   }
   ```
   免克隆方式——`npx -y github:yeuimu/scrader`（Windows 客户端用 `cmd /c npx ...` 包装）。
3. **决策 Key**（可选，仅 `decide` 需要）—— 把 `mcp-server/providers.example.json` 复制为：
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

## 安全

桥接只监听 `127.0.0.1` · 密钥只存用户配置目录（永不入库）· 域名 allowlist（扩展选项页）· 审计日志 `SCRADER_LOG=<文件>`。

## 开发

```bash
node mcp-server/selftest.js     # 全链路自测，无需 Chrome
node mcp-server/scrader-mcp.js --check
```

MIT
