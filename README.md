# scrader

<p align="center"><img src="hands/browser/extension/icons/icon128.png" width="96" alt="scrader icon"></p>

**S**pider + sc**r**aper — 浏览器操作与网页采集作为 [MCP](https://modelcontextprotocol.io) 工具，可对接任意 AI Agent（ZCode / Claude Desktop / Cursor / Cline …）。

[English Documentation](README.md)

## 项目结构

```
core/          brain: MCP API + 决策 + 路由
hands/         effectors: 浏览器(扩展+桥接+采集) / CUA(客户端+适配器+平滑)
eyes/          gaze: 截图 → YOLO+OCR → 元素识别
motion/        humanized trajectory (单源双后端)
docs/          架构文档详见 ARCHITECTURE.md
```

## 核心特性

- **18 个 MCP 工具** — 标签页管理、页面读取、`evaluate`（任意 JS 执行）、截图等
- **可信拟人输入** — 点击/填表/滚动通过 `chrome.debugger` (`isTrusted=true`) 实现，带贝塞尔曲线路径、抖动、逐键打字节奏；自动降级到合成事件
- **`harvest`** — 通用列表采集器：反虚拟列表滚动、稳定 ID 去重、两遍间隙填充、图片归一化
- **`decide`**（可选）— Jev 快速决策：TypeSafe → OpenRouter → 任意 OpenAI 兼容 LLM
- **无需 CDP 端口 9222** — 无需"允许调试"授权提示

## 架构设计

```
Agent (MCP stdio) ── core/index.js ── HTTP 127.0.0.1:7827 ── bridge.js ── WebSocket ── Chrome 扩展 (MV3)
```

扩展拥有浏览器控制权；桥接服务在需要时自动启动。

## 安装

### 1. 安装 Chrome 扩展

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `hands/browser/extension/` 目录

### 2. 配置 MCP 服务端

在 MCP 客户端配置中添加：

```json
{
  "mcp": {
    "servers": {
      "scrader": {
        "command": "node",
        "args": ["<项目路径>/core/index.js"]
      }
    }
  }
}
```

或者无需克隆：

```bash
npx -y github:yeuimu/scrader
```

> Windows 客户端：用 `cmd /c npx ...` 包装

### 3. 决策密钥（可选，仅用于 `decide` 功能）

将 `core/providers.example.json` 复制到：

- Windows: `%APPDATA%\scrader_mcp\config.json`
- macOS / Linux: `~/.config/scrader_mcp/config.json`

### 4. 视觉模型权重（可选，用于截图分析）

下载 `gaze-weights-<version>.zip` 并解压到 `eyes/gaze/weights/` 目录

重启 Agent 会话，工具将以 `mcp__scrader__*` 前缀出现。

## 工具列表

| 类别 | 工具 |
|------|------|
| 标签页 | `status` `list_tabs` `open_tab` `close_tab` `activate_tab` `navigate` |
| 读取 | `read_page` `snapshot` `extract` `screenshot` |
| 操作 | `evaluate` `click` `fill` `press_key` `scroll` `wait_for` |
| 采集/决策 | `harvest` `decide` |
| 桌面（可选）| `desktop` |

## harvest 使用示例

```javascript
harvest({
  itemSelector: 'a[href*="-g-"]',   // 电商商品卡片
  maxItems: 200,
  fields: [
    { key: 'price',     pattern: '(\\d[\\d,]*)円', kind: 'int' },
    { key: 'soldCount', pattern: '已售([\\d,.]+[万K]?)件' },
  ],
})
// → { items: [...], stats: { count, null_price, uniqueImages, … } }
```

`stats.null_*` 飙升表示页面 markup 发生变化——请查看配置目录中的 `experiences/` 笔记。

## 桌面应用自动化（可选）

`desktop` 代理本地 [cua-driver](https://github.com/trycua/cua) 守护进程（`cua-driver call <method> <json>`），用于后台原生桌面自动化——UIA 元素点击不抢占焦点。

智能内置方法：

- `find_window({title})` — 按标题定位顶层窗口（处理对话框 PID 每次启动都变化的情况）
- `set_text({pid,window_id,element_token,value})` — 向原生控件写入文本（UIA set_value → 键盘回退，反斜杠安全，回读验证）
- 键盘方法自动先 `bring_to_front`

安装方式（PowerShell）：

```powershell
$env:CUA_DRIVER_RS_VERSION="0.28.2"; irm https://cua.ai/driver/install.ps1 | iex
cua-driver autostart kick
```

安装后工具自动启用；不安装时其他功能保持正常工作。浏览器页面继续使用 scrader 自有的 DOM 级别工具。

## 安全特性

- 桥接服务仅绑定 `127.0.0.1`
- 密钥仅存放在用户配置目录（永不提交到 git）
- 选项页面可配置域名白名单
- 支持通过 `SCRADER_LOG=<文件>` 启用审计日志

## 开发

```bash
# 自检测试（无需 Chrome）
node test/selftest.js
# 或
npm run selftest

# 服务端检查
node core/index.js --check
```

## 许可证

MIT

## Agent 安装使用指南

> 将以下提示发送给任意支持 MCP 的 Agent 以安装、配置和验证 scrader。具体使用决策树和实战规则见 `skills/scrader/SKILL.md`（复制到 Agent 的 skills 目录以实现自动触发）。

```
在此机器上安装和配置 scrader（通用浏览器/桌面控制器）：

1) 打开 https://github.com/yeuimu/scrader/releases 下载三个包：
   - scrader-extension-<version>.zip（浏览器扩展）
   - gaze-weights-<version>.zip（视觉权重）
   - Source code (zip)（服务端源码；解压到固定目录；需要 Node >= 18）
   （如果还没有 asset zip：仅 Source code 包即可 — 从 hands/browser/extension/ 加载解压后的扩展，eyes/gaze/weights/ 已包含所有 YOLO+OCR 权重）

2) 扩展：chrome://extensions → 开发者模式 → "加载已解压的扩展" → 选择解压的扩展文件夹。

3) MCP 配置：在主机的 MCP 配置中添加服务端 — command=node, args=["<源码目录>/core/index.js"]，然后重载 MCP。

4) decide（可选）：询问我是否有 TypeSafe Jev API 密钥；如有，将 <源码目录>/core/providers.example.json 复制到用户配置目录
   （Windows: %APPDATA%/scrader_mcp/，其他: ~/.config/scrader_mcp/）并命名为 config.json，然后填写密钥。

5) cua-driver 桌面自动化（必需）：在 PowerShell 中运行
   $env:CUA_DRIVER_RS_VERSION="0.28.2"; irm https://cua.ai/driver/install.ps1 | iex
   然后 cua-driver autostart kick。

6) 视觉权重：将 gaze-weights-<version>.zip 解压到 <源码目录>/eyes/gaze/weights/（YOLO 图标检测 + OCR 权重）。
   Python 依赖自检：uv run --with rapidocr-onnxruntime --with onnxruntime --with opencv-python-headless --with numpy python <源码目录>/eyes/gaze/gaze.py --help

7) 验证：scrader status 工具报告扩展已连接；read_page 在任意打开的页面上正常工作；desktop 工具调用 list_apps 确认 cua 可用。

逐步执行；在需要确认的操作前询问我（扩展加载、密钥输入）。然后遵循 skills/scrader/SKILL.md。
```

## 相关文档

- [架构设计](docs/ARCHITECTURE.md)
- [版本策略](docs/VERSIONING.md)