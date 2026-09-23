---
name: scrader
description: 通用浏览器/桌面自动化控制器（MCP）。当用户要求操作浏览器（导航/点击/填表/滚动/截图/读页面）、批量采集列表页数据（商品/搜索结果/瀑布流）、自动化 Windows 桌面应用、或需要在自动化循环中做快速决策（选下一步动作/goal_done/stuck）时使用。Use when the user asks to operate a browser, harvest list pages, automate a desktop app, or needs fast in-loop decisions.
---

# scrader —— 浏览器/桌面控制器使用指南

三层架构：`core`（脑：Agent API + decide 决策）→ `hands`（手：浏览器扩展 / cua-driver 桌面）→ `eyes`（眼：DOM / UIA / gaze 截图视觉）+ `motion`（拟人轨迹横切层）。详细架构见仓库 `docs/ARCHITECTURE.md`。

## 工具选择决策树

| 任务 | 用什么 | 备注 |
|---|---|---|
| 浏览器导航/点击/填表/滚动/截图/读页 | scrader 本体工具（navigate/click/fill/scroll/read_page/snapshot/evaluate） | click/fill 默认受信输入+拟人化 |
| 批量采集列表（商品/结果/瀑布流） | `harvest`（itemSelector + fields 正则） | **先查用户目录 experiences/ 站点笔记** |
| 自动化循环的单步决策 | `decide`（state+questions → 选候选/goal_done/stuck） | 先探活（见铁律 1），~2s/次 |
| 桌面原生应用（计算器/客户端/安装器） | `desktop`（cua-driver 代理） | 浏览器页面仍用 scrader 本体；element_token 优先于坐标 |
| 视觉定位（canvas/游戏/无 DOM 表面） | gaze：截图 → YOLO+OCR → 元素列表（`eyes/gaze/gaze.py`） | 坐标语义裁决：UIA label > VLM > OCR |
| 拟人滑行/点击（真实指针） | `hands/cua/glide.js`（消费 motion timeline） | 用于强风控关键动作 |
| 数据导出 Excel | 用户目录 recipes/ 配方（如 recipes/temu/export_temu_xlsx.py） | 配方属场景，不在本仓库 |

## 新机器安装（国内网络优先，Gitee Release，无需 clone）

一键检测安装（缺什么补什么：Node→npmmirror、Python 依赖→清华 PyPI、cua-driver→Gitee 镜像）：
`irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex`（演练加 `-DryRun`）
分包装下载：https://gitee.com/yeuimu/scrader/releases （扩展 zip、gaze-weights zip、cua-driver 镜像 zip、源码包；海外备选 github.com/yeuimu/scrader/releases）。

**1. 浏览器面（必装）**：解压扩展 zip → `chrome://extensions` → 开发者模式 → 加载已解压；服务端源码解压后，在宿主 MCP 配置添加：`command=node, args=["<源码目录>/core/index.js"]`（免克隆：`npx -y git+https://gitee.com/yeuimu/scrader.git`）。

**2. cua-driver 桌面面（必装，Windows）**——二选一：
国内镜像（推荐）：`powershell -ExecutionPolicy Bypass -File scripts\cn-setup.ps1`（Gitee Release 镜像，官方 cua.ai 安装包的 MIT 原样转存）
官方渠道（海外）：```powershell
$env:CUA_DRIVER_RS_VERSION = "0.28.2"; irm https://cua.ai/driver/install.ps1 | iex
cua-driver autostart kick
```

**3. decide 决策（可选）**：询问用户是否有 TypeSafe Jev Key；有则 `core/providers.example.json` → 用户配置目录 `config.json`（Windows `%APPDATA%scrader_mcp`，其余 `~/.config/scrader_mcp/`）填入，或用环境变量；llm 兜底支持任意 OpenAI 兼容端点（国内可填 DeepSeek/GLM）。

**4. gaze 视觉感知**：gaze-weights zip 解压到 `eyes/gaze/weights/`（YOLO 图标检测 + OCR 识别权重）；Python 依赖：有 uv 则先设 `UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple` 再 `uv run --with rapidocr-onnxruntime --with onnxruntime --with opencv-python-headless --with numpy python eyes/gaze/gaze.py <截图.png>`；无 uv 用 cn-setup 建的 `eyes/gaze/.venv/Scripts/python.exe`（venv+清华 pip，不强装 uv）。

**验证**：调 scrader 的 `status` 工具（扩展已连接）→ `read_page` 任一页面 → 全链路通。

## 铁律（实战固化，违反必踩坑）

1. **Jev 探活一次再进循环**：发一个小问题（choice+goal_done），返回 `provider:"jev:*"` 即可用；失败则主模型自行决策，本轮不再探测。Jev 只做"在给定候选中选一个"+守护，**选项构造质量决定其决策质量**。
2. **节奏放慢**：翻页间隔 2~6 秒随机抖动、批次间插无目的小滚动、单会话限量、关键词之间留冷却。等距间隔是机器指纹。
3. **采集任务先查站点笔记**：`%APPDATA%\scrader_mcp\experiences\`（每站一份，Agent 读写）。
4. **读取永远走 DOM**（harvest/evaluate，零输入事件零暴露）；拟人动作只花在必要处（搜索提交/强风控）。
5. **坐标**：cua `click` 的 x,y = `get_window_state` 截图 PNG 像素空间；窗口会被用户拖动/改尺寸，**每个动作前重取几何**，绝不缓存。
6. **元素语义裁决**：UIA label（`get_window_state query:` 参数，确定性）> VLM 看 SoM 图（会认错编号）> OCR 文本。
7. **Chromium 拒收后台输入**：cua 动作一律 `delivery_mode:"foreground"`；滚动用阅读式节奏（滑一截停一停看商品），匀速滚到底会触发列表重置陷阱。

## 典型任务流（搜索 → 采集 → 导出）

```
scrader open_tab 打开目标站 → 拟人点击搜索框（UIA 定位坐标 + hands/cua/glide）
→ type_text 输入关键词 → 前台点击搜索按钮 → harvest 循环（读取→翻页抖动→合并去重→落盘）
→ recipes 配方导出 Excel；全程 decide 做循环决策（探活后）
```
