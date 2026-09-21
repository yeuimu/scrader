# scrader (spider + scraper)

把"操作浏览器 + 抓取网页"的能力打包成一个 Chrome 扩展，通过本地桥接进程暴露为 **MCP 工具**，
任何 Agent（ZCode / Claude Desktop / Cursor / Cline …）都能直接调用；`decide` 工具接 **Jev 快速决策**
（TypeSafe 官方 API 优先，OpenRouter 次之，LLM 兜底），`harvest` 工具内置抗虚拟列表的通用采集算法。

## 架构

```
┌─────────────┐  stdio(MCP)  ┌──────────────────┐   HTTP 127.0.0.1:7827   ┌─────────────────────┐
│  任意 Agent   │ ◄──────────► │  scrader-mcp.js   │ ◄─────────────────────► │  bridge.js（常驻）    │
│ (ZCode/Claude)│              │  含 harvest/decide │                         │  WS /ws + HTTP /tool │
└─────────────┘              └──────────────────┘                          └─────────┬───────────┘
                                                                                     │ WebSocket
                                                                              ┌────────▼──────────┐
                                                                              │ scrader 扩展 (MV3)  │
                                                                              │ 只管浏览器操作：      │
                                                                              │ tabs/scripting/    │
                                                                              │ 受信拟人化输入       │
                                                                              └───────────────────┘
```

职责分离：**扩展管浏览器**（v0.4.0 起不含任何密钥），**用户配置目录管密钥与经验**，**MCP 服务器管编排**。

- **不走 Chrome 远程调试开关（CDP 9222）**：没有任何"允许外部应用调试"的同意弹窗。
- **受信拟人化输入**：click/fill/press_key/scroll 默认走 `chrome.debugger` Input 域（`isTrusted=true`），
  含贝塞尔曲线鼠标轨迹、坐标抖动、逐字符随机节奏键入、滚轮序列；失败自动降级合成事件（结果 `via` 字段标明）。
- **CSP 兜底**：`evaluate` 被页面 CSP 拦截时自动改走 CDP。
- **保活**：WS ping 每 20s + alarms 每 30s 兜底重连；桥接不在时 scrader-mcp 自动拉起。

## 快速开始（Getting Started）

1. **扩展**：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `extension/`（开发者模式保持开启）
2. **决策 Key（可选，仅 decide 需要）**：把 `server/providers.example.json` 复制到用户配置目录并填 Key：
   - Windows：`%APPDATA%\scrader_mcp\config.json`（即 `C:\Users\<你>\AppData\Roaming\scrader_mcp\config.json`）
   - macOS / Linux：`~/.config/scrader_mcp/config.json`
   - 或用环境变量 `SCRADER_TYPESAFE_API_KEY` 等（见下）；`SCRADER_CONFIG_DIR` 可自定义目录
3. **Agent 侧**：MCP 配置加一条（路径按机器改）：
   ```json
   { "mcp": { "servers": {
     "scrader": { "command": "node", "args": ["<项目路径>/server/scrader-mcp.js"] }
   } } } }
   ```
4. 重启 Agent 会话，工具以 `mcp__scrader__*` 出现；点扩展图标确认"已连接桥接"

验证：`node server/test-decide.js`（测 Key）；`node server/scrader-mcp.js --check`（测桥接）。

## 用户配置目录

```
%APPDATA%\scrader_mcp\（Windows）或 ~/.config/scrader_mcp/（macOS/Linux）
├── config.json        # 提供商/密钥（schema 见 providers.example.json：jevOrder/typesafe/openrouter/llm）
└── experiences/       # 站点采集经验笔记（每站一份 md，Agent 读写；接到采集任务先查这里）
```

查找仅两级：`SCRADER_PROVIDERS`（直接指文件）→ 上述目录 `config.json`。扩展选项页只有端口/allowlist。

## 工具（18 个）

| 类别 | 工具 |
|---|---|
| 标签页 | `status` `list_tabs` `open_tab` `close_tab` `activate_tab` `navigate` |
| 页面读取 | `read_page`（全文） `snapshot`（可交互元素+选择器） `extract`（结构化行提取） `screenshot` |
| 页面操作 | `evaluate`（任意 JS，支持 async/return） `click`（selector 或 **text** 定位） `fill` `press_key` `scroll`（含 untilText 目标滚动） |
| 采集/决策 | `harvest`（通用列表采集） `decide`（Jev→LLM 决策） |

### harvest 示例（Temu，来自 experiences/temu.md）

```
harvest({
  tabId: <搜索结果页>,
  itemSelector: 'a[href*="-g-"]',
  stableIdPattern: '-g-(\\d+)\\.html',
  maxItems: 40,
  fields: [
    { key: 'price',         pattern: '(\\d[\\d,]*)円', kind: 'int' },
    { key: 'originalPrice', pattern: '原价\\s*([\\d,]+)円', kind: 'int' },
    { key: 'soldCount',     pattern: '已售([\\d,.]+[万KMBkmb]?\\+?)件' },
  ],
})
```
内置：小步滚动+停滞检测、按 stableId 合并去重、慢速二遍补采、图片规范化（取卡内最大产品图，排除角标/占位）。
返回 `stats.null_*` 空值计数——突然升高 = 站点改版预警，配合 experiences 笔记排查。

CLI（可挂定时任务）：`node server/scrader-mcp.js --harvest '{"itemSelector":"a[href*=\"-g-\"]","maxItems":40}'`

## 决策链（decide）

默认顺序：TypeSafe 官方 `api.typesafe.ai/v1/systemone`（`jev-latest`）→ OpenRouter `typesafe/jev-1.13` →
任意 OpenAI 兼容 LLM 兜底。协议与 jev-for-chrome 相同：`{state, questions}` → `{answers:{qid:{choice,probabilities,confidence}}}`。
配置即用户配置目录 config.json 的 `jevOrder`/`typesafe`/`openrouter`/`llm` 字段，或环境变量
`SCRADER_TYPESAFE_API_KEY` / `SCRADER_OPENROUTER_API_KEY` / `SCRADER_LLM_BASE_URL|API_KEY|MODEL`。

## 安全说明

- 桥接只监听 127.0.0.1；密钥只在用户配置目录，不进 git、不经过第三方（除 decide 的显式出网调用）
- 域名 allowlist：扩展选项页配置（默认 `*`），`navigate`/所有页面级工具强制校验
- 审计日志：`SCRADER_LOG=<路径>` 启动 bridge 即记录每次调用

## 开发与测试

```bash
node server/selftest.js      # 全链路自测（桥接+模拟扩展+MCP stdio+harvest 代码生成，无需 Chrome）
node server/test-decide.js   # 决策 API 连通性
node server/scrader-mcp.js --check
```

## Roadmap

- 站点经验库充实（experiences/ 每站一份，Agent 自维护）
- 网络层抓取（chrome.debugger Network 域，拿接口响应体）
- Edge 直接可用；Firefox 适配
