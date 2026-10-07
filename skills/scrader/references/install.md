# agent 自主安装 runbook（引导脚本跑完后，agent 按此完成剩余安装）

前置：引导脚本已就位三样——Node≥18、技能（~/.agents/skills/scrader）、cua-driver。
本 runbook 的每一步都是 agent 可执行的动作；扩展加载不再是"手工步骤"——**cua 装好后 agent 就能操作电脑，扩展加载由 agent 自动完成**。

## 第 1 步：注册进本宿主

```
node <源码>/scripts/register.js --agent pi        # pi：幂等写 mcp.json + 技能
node <源码>/scripts/register.js --list            # 看支持列表
```
不在表里的宿主：按各自 MCP 配置格式手工加 `{"command":"node","args":["<源码>/core/index.js"]}`，技能拷到该宿主技能目录（SKILL.md 约定跨工具通用）。
**完成后需重连**（重启会话/重载 MCP），工具以 `mcp__scrader__*` 出现。

## 第 2 步：cua 自动加载浏览器扩展（无需用户动手）

Chrome/Edge 都适用（chromium://extensions UI 同构）。用 scrader 的 desktop 工具（或 cua-driver CLI）：

1. **打开扩展页**：`open_tab` → `chrome://extensions`（Edge: `edge://extensions`）
2. **开开发者模式**：`find_window` 定位浏览器窗口 → `get_window_state query:"开发者|Developer"` → 找开关（role=Switch/Button）→ 现取 element_token `click`（token 即取即用，勿跨快照缓存）
3. **点"加载已解压的扩展程序 / Load unpacked"**：`get_window_state query:"加载已解压|Load unpacked"` → `click`
4. **文件夹选择对话框**（关键：**宿主 pid 每次都变**，必须 `find_window({title:"打开|Open"})` 现找）：
   - 文件名输入框：`set_text`（UIA set_value，**反斜杠安全**，写完自动回读校验）填 `<源码>\hands\browser\extension` 的绝对路径
   - 点「选择文件夹 / Select Folder」按钮（foreground）
5. **验证**：扩展页出现 scrader 条目；`status` 工具显示扩展已连接（bridge 7827）

UIA 铁律（全部实战验证过）：对话框宿主 pid 每次变→find_window 跨进程按标题找；控件写文本一律 set_text 不走键盘；Chromium 后台拒收输入→关键点击 `delivery_mode:"foreground"`；token 绑定快照→扫描后立即动作，绝不插入新扫描。
若浏览器是首次启动（无障碍树薄），扫两次拿全树。

## 第 3 步：全链路验证

```
scrader status        → 扩展已连接
scrader read_page     → 任一打开页面
scrader desktop list_apps  → cua 正常（若已装）
```

## 第 4 步（可选加重，agent 按需自装）

- **gaze 视觉感知**：`uv run --with rapidocr-onnxruntime --with onnxruntime --with opencv-python-headless --with numpy python <源码>/eyes/gaze/gaze.py --help`（权重已在源码里；无 uv 则建 venv 用清华源 pip）
- **decide 密钥**：`<源码>/core/providers.example.json` → `%APPDATA%/scrader_mcp/config.json`（llm 兜底可填 DeepSeek/GLM 等 OpenAI 兼容端点）
- **npm 源**（国内）：`npm config set registry https://registry.npmmirror.com`
