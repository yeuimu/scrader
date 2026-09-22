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
| `eyes/gaze/` | gaze.py（截图→YOLO+OCR→归一化元素列表，独立一次性）、gaze_server.py（常驻 HTTP 解析服务）、weights/ | Python: onnxruntime/rapidocr/opencv |
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

## 眼层服务化（视觉闭环）

纯视觉闭环「截图→YOLO+OCR→归一化元素列表→决策→cua 拟人动作→再截图验证」已实测可行（Edge+Gitee 导航命中，光标压点 0px 偏差）。感知端两种用法：

- 一次性 CLI：`gaze.py <shot.png> --out elements.json`（每次重载 80MB 模型，适合调试/SoM 出图）
- 常驻服务（产线推荐，省每次模型加载）：`python eyes/gaze/gaze_server.py --port 8765` 起，`curl --data-binary @shot.png http://127.0.0.1:8765/parse?max_dim=N` 收同构 JSON；`/health` 看状态。Python 依赖经 `uv run --with numpy --with onnxruntime --with rapidocr-onnxruntime` 拉起

决策端 `decide`：jev 通道按 `jevOrder` 过滤有 key 者依次尝试（网络抖动退避重试），LLM 兜底仅在配置了 apiKey 时参与，无 key 明确跳过不报 401。

## 坐标铁律（踩坑固化）

1. cua `click` 的 x,y = get_window_state 返回 PNG 的像素空间（感知 center_px 直接喂）
2. 窗口会被人拖动/改尺寸：动作前重取几何，绝不缓存
3. Chromium 拒收后台输入 → 一律 `delivery_mode:"foreground"`
4. 元素语义裁决优先级：UIA label（get_window_state query）> VLM 看 SoM 图（辅助）> OCR 文本
5. **前台 global_input 点击打的是当前光标位置** → 拟人滑轨（humanGlide）是定位载体而非装饰：先滑到目标再点击，滑轨终点即点击点
6. **PNG 坐标空间必须成对**：`geom.pngToScreen` 的坐标要与 pngW/pngH 同源（getGeom 内部截图是 400px 压缩小图；喂全尺寸截图的 center_px 必须显式传那次的 pngW/pngH）；滑轨换算用无障碍树的客户区 bounds（最大化窗口为 0,0 起），不是 find_window 的窗口矩形（含不可见边框，负偏移）

## 桌面窗口铁律（原生对话框之战固化，adapter 智能层已内置）

1. 原生控件写文本一律 `set_text`：先 UIA set_value，控件无 ValuePattern（经典记事本等）自动转键盘兜底（反斜杠走 press_key 真键码——type_text 的 WM_CHAR 在部分输入法下吞 `\`），写完自动回读校验
2. 对话框宿主 pid 每次都变 → `find_window({title})` 按标题跨进程枚举（PowerShell EnumWindows；cua-driver 的 window_id 即 Win32 hwnd，可直接续用）
3. 键盘类注入（type_text/press_key/hotkey）可能被 Windows 前台锁吞 → adapter 自动先 bring_to_front（args.auto_front=false 关闭）
4. 合成组合键可能泄漏裸键（ctrl+a 打出"a"）→ 永远以回读校验为准，不信"发送成功"
