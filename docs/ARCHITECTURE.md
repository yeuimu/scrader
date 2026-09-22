# scrader 架构

## 分层模型

```
scrader = 通用浏览器/桌面控制器（与"操作什么站点"无关）
│
├── 脑  core/        Agent API（MCP stdio）+ 决策(decide: Jev→LLM) + 编排路由
├── 手  hands/       执行面（每只手自带其感知方法）
│      ├─ browser/   浏览器：extension(DOM 读写+CDP 受信输入) + bridge.js(本地服务) + harvest.js(采集代码生成)
│      └─ cua/       桌面应用：client(常驻 cua-driver MCP) + adapter(UIA 读/真实输入) + geom(坐标换算) + glide(拟人执行器)
├── 眼  eyes/gaze/   截图视觉感知（YOLO+OCR→元素列表）——唯一需独立存在的眼；
│                    DOM/UIA 感知分别内置于 browser/cua 两只手，不单独建目
├── 拟人层 motion/   横切：轨迹算法与参数唯一源（buildTimeline 纯函数），双后端共用
└── 用户空间         %APPDATA%/scrader_mcp（或 ~/.config/scrader_mcp）：config.json 密钥、
                     experiences/ 站点经验、recipes/ 站点配方 —— 不属于本仓库
```

判据：**能力进仓库，场景进用户目录。**

## 目录 ↔ 职责

| 目录 | 职责 | 依赖 |
|---|---|---|
| `core/` | MCP 入口、工具表、decide、桥路由 | hands/*（仅路由引用） |
| `hands/browser/` | 扩展、桥、harvest 代码生成 | — |
| `hands/cua/` | cua-driver 常驻客户端、UIA/输入门面、坐标换算、拟人执行器 | motion/ |
| `eyes/gaze/` | gaze.py（截图→YOLO+OCR→归一化元素列表）、weights/ | Python: onnxruntime/rapidocr/opencv |
| `motion/` | CFG + buildWaypoints/buildTimeline（纯函数，含单测） | 零依赖 |
| `scripts/` | build-extension.js（motion→扩展 vendor 构建步骤） | — |

## 数据流（一次工具调用）

```
Agent ⇄ core/index.js (MCP stdio)
          ├─ decide ──────────────→ Jev(TypeSafe→OpenRouter)→LLM   [脑，本地]
          ├─ 浏览器工具 ─→ HTTP → bridge.js ⇄ WS ⇄ extension → 页面  [browser 手]
          │    └─ harvest = genHarvestCode() 生成的页面 JS 走 evaluate
          └─ desktop ──→ adapter/client → cua-driver → UIA/SendInput [cua 手]
```

## 拟人轨迹（横切层）

- 唯一源头：`motion/trajectory.js` 的 `buildTimeline(sx,sy,tx,ty)` → `[{x,y,tMs}]`
- 两个执行后端只写"照表执行"：
  - `hands/cua/glide.js`：`move_cursor` 逐点（真实系统指针，~80Hz）
  - 扩展 `background.js`：CDP `Input.dispatchMouseEvent` 逐点（受信 mousemove 事件流）
- 扩展消费的是**构建产物** `extension/vendor/trajectory.js`（`npm run build:extension` 生成，CI `--check` 防漂移）；改算法只改 motion，构建后重载扩展。

## 坐标铁律（踩坑固化）

1. cua `click` 的 x,y = get_window_state 返回 PNG 的像素空间（感知 center_px 直接喂）
2. 窗口会被人拖动/改尺寸：动作前重取几何，绝不缓存
3. Chromium 拒收后台输入 → 一律 `delivery_mode:"foreground"`
4. 元素语义裁决优先级：UIA label（get_window_state query）> VLM 看 SoM 图（辅助）> OCR 文本
