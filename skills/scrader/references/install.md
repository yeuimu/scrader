# agent 自主安装 runbook（引导脚本跑完后，agent 按此完成剩余安装）

前置：引导脚本已就位三样——Node≥18、技能（~/.agents/skills/scrader）、cua-driver。
本 runbook 的每一步都是 agent 可执行的动作；扩展加载不再是"手工步骤"——**cua 装好后 agent 就能操作电脑，扩展加载由 agent 自动完成**。
以下流程于 2026-10 在真机（Win10 + Chrome 126 + Edge 126）端到端实测通过。

## 第 1 步：注册进本宿主

```
node <源码>/scripts/register.js --agent pi        # pi：幂等写 mcp.json + 技能
node <源码>/scripts/register.js --list            # 看支持列表
```
不在表里的宿主：按各自 MCP 配置格式手工加 `{"command":"node","args":["<源码>/core/index.js"]}`，技能拷到该宿主技能目录（SKILL.md 约定跨工具通用）。
**完成后需重连**（重启会话/重载 MCP），工具以 `mcp__scrader__*` 出现。

## 第 2 步：cua 自动加载浏览器扩展（无需用户动手）

> ⚠️ 此时**扩展还不存在，open_tab / navigate 等 bridge 工具全部不可用**——chrome:// 页面本来也不能用 open_tab 打开。本步全程只用 desktop 工具。

1. **打开扩展页**（纯键盘，已实测）：
   `find_window` 定位浏览器窗口（记 pid + window_id）→ `press_key` Ctrl+L（**必须 delivery_mode:"foreground"**，Chromium 后台拒收输入）→ `type_text` 输入 `chrome://extensions\n`（Edge: `edge://extensions`）。
   验证：`get_window_state` 窗口标题变为"扩展程序"。
2. **开开发者模式**：`get_window_state query:"开发者模式"`（**query 只支持单个子串，不支持正则 `|`**）→ 开关 role=Button id=devMode `selected:true` 即已开；未开则现取 token 前台点击。该开关按浏览器配置持久，一般只需设一次。
3. **点"加载未打包的扩展程序"**（注意：**新版 Chrome 文案是「加载未打包」不是「加载已解压」**；Edge 是「加载解压缩的扩展」）→ `get_window_state query:"加载"` → 取 loadUnpacked 按钮 token。
   点击阶梯（同一台 Win10 实测：cua 前台鼠标点击在 Chromium **网页内容**上经常只留 hover 不触发 click，工具栏原生按钮则正常）：
   a. 先 `click` element_token + foreground（多数机器直接成功）；
   b. 无效果（按钮出现悬停高亮但无对话框）→ **PostMessage 兜底**：`powershell -File <源码>/scripts/pmclick.ps1 -X <客户区x> -Y <客户区y> -Hwnd <窗口hwnd>`（向窗口投递 WM_LBUTTONDOWN/UP；UIA frame 坐标即窗口客户区坐标）。
4. **文件夹选择对话框**（关键细节全部实测）：
   - 标题是**「选择扩展程序目录。」**（不是"打开"）；宿主是**另一个 chrome 工具进程（pid 与主窗口不同！）**——`find_window({title:"选择扩展程序目录"})` 现找 → `list_windows({pid})` 拿 cua window_id；
   - 底部"文件夹:"Edit 用 `set_text`（UIA set_value，**反斜杠/中文安全**）填 `<源码>\hands\browser\extension` 绝对路径；
   - set_text 后对话框会**导航进该目录**（Edit 值变成末段"extension"）且**旧 token 全部失效**——必须重扫；
   - 重扫取「选择文件夹」按钮 token → `click` foreground。若报 `foreground_unavailable` 且 actual foreground 是同浏览器主窗口——**这通常是成功**（对话框关闭、焦点回主窗口），直接用 `status` 验证。
5. **验证**：`status` 显示 `connected` 且 version = 源码版本号。失败排查：扩展页是否报错卡片（manifest 路径不对/加载了内层目录）。

UIA 铁律（全部实战验证）：**token 即取即用**——任何 set_text/导航/等待之后旧 token 作废，必须重扫；query 单子串；Chromium 一律 foreground；冷树扫两次；同位置窗口互相遮挡时先最小化无关窗口（explorer 文件夹窗口常与浏览器完全重叠，点击会被它吃掉）。

## 卸载/重装（agent 自测或换目录时）

- Chrome：扩展页卡片"移除"按钮 → 弹出**独立原生对话框窗口**（标题「要删除"X"吗？」，**位于屏幕右上角**，不属于扩展页窗口——在扩展页窗口内扫"取消"永远扫不到！）→ `find_window({title:"要删除"})` → 对话框内"移除"按钮是原生控件，前台点击直接生效。
- Edge：卡片行内"删除"链接（卡片下方小字按钮）→ 独立对话框「是否从 Microsoft Edge 中删除 "X"?」→ 点"删除"。
- 网页内容点击不响应时同样用 pmclick.ps1 兜底。

## 第 3 步：全链路验证

```
scrader status        → connected + bridge.clients 清单（多浏览器各装一份时按 UA 标记 chrome/edge）
scrader read_page     → 任一打开页面
scrader click(trusted)→ 任一链接，确认无挂起且发生导航（withDebugger 8s 自愈已内置）
scrader desktop list_apps → cua 正常
```

## 第 4 步（可选加重，agent 按需自装）

- **gaze 视觉感知**：`uv run --with rapidocr-onnxruntime --with onnxruntime --with opencv-python-headless --with numpy python <源码>/eyes/gaze/gaze.py --help`（权重已在源码里；无 uv 则建 venv 用清华源 pip）
- **decide 密钥**：`<源码>/core/providers.example.json` → `%APPDATA%/scrader_mcp/config.json`（llm 兜底可填 DeepSeek/GLM 等 OpenAI 兼容端点）
- **npm 源**（国内）：`npm config set registry https://registry.npmmirror.com`
