---
name: scrader
description: 通用浏览器/桌面自动化控制器（MCP）。当用户要求操作浏览器（导航/点击/填表/滚动/截图/读页面）、批量采集列表页数据（商品/搜索结果/瀑布流，尤其 Temu）、自动化 Windows 桌面应用、需要快速循环决策（decide）、或遇到"采集被封/打不开/验证页"时使用。也用于在其他 agent（pi 等）上安装配置 scrader。Use whenever the user asks to operate a browser, harvest list pages (especially Temu), automate a desktop app, install scrader on a new machine or agent, or deal with scraping blocks.
---

# scrader —— 浏览器/桌面控制器（安装 → 使用 → 采集协议）

三层架构：`core`（脑：MCP API + decide）→ `hands`（手：浏览器扩展 / cua 桌面 / **act 意图动词层**）→ `eyes`（DOM / UIA / gaze 视觉）+ `motion`（拟人轨迹）。仓库 `docs/ARCHITECTURE.md`。

## 一、安装（新机器 / 新 agent，全部 Gitee 优先，无 GitHub 依赖）

**一键（推荐）**——纯引导只管依赖与源码（Node≥18 检查→npmmirror、Python 依赖→清华 PyPI、cua-driver→Gitee 镜像；结尾 node core/index.js --check 自检）：
```
irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
```

**手工两步（核心功能只需这两步，前置 Node ≥ 18）**：
1. 扩展：`chrome://extensions` → 开发者模式 → 加载已解压 → 选 `hands/browser/extension/`（来自源码包或 release 的 scrader-extension zip）
2. MCP 注册（任意 MCP host）：
   ```json
   {"command": "node", "args": ["<源码目录>/core/index.js"]}
   ```
   免克隆：`npx -y git+https://gitee.com/yeuimu/scrader.git`

**可选加重项**：cua-driver 桌面自动化（cn-setup 已含；海外 `irm https://cua.ai/driver/install.ps1 | iex`）；gaze 视觉感知（权重已在 git 里，clone 即得）；decide 密钥（`core/providers.example.json` → `%APPDATA%/scrader_mcp/config.json`，llm 兜底可填 DeepSeek/GLM）。

**装进 pi 等其他 agent**：`node <源码>/scripts/register.js --agent pi`——表驱动注册器（幂等写 mcp.json + 装技能，`--list` 看支持列表；安装器 cn-setup 不含框架知识）。装完重启会话，工具以 `mcp__scrader__*` 出现。

**首次验证**：`status` 显示扩展已连接 → `read_page` 任一页面 → `desktop` 调 `list_apps`（若装了 cua）。

## 二、使用决策树

| 任务 | 用什么 | 备注 |
|---|---|---|
| 浏览器导航/点击/填表/滚动/截图/读页 | 本体工具（navigate/click/fill/scroll/read_page/snapshot/evaluate） | click/fill 默认受信输入+拟人化 |
| 批量采集列表（商品/结果/瀑布流） | `harvest` + 采集协议（下节） | **先读 references/temu.md（Temu 必读）** |
| 意图式浏览（逛详情/看评论/点击验证） | `hands/act/act.js --plan`（先演练后执行） | 零知识站点：演练看缺口→探察→入库→复跑 |
| 采集前检查 / 被封处置 | `hands/act/guard.js`（check/gate/warmup/block） | 协议见下节 |
| 桌面原生应用 | `desktop`（cua-driver 代理） | element_token 优先于坐标 |
| 视觉定位（canvas/无 DOM 表面） | gaze（截图→YOLO+OCR→元素） | `eyes/gaze/gaze.py` |
| 自动化循环单步决策 | `decide`（Jev，探活一次再用） | 选项构造质量决定决策质量 |
| 数据导出 Excel | 用户目录 `recipes/`（temu: export_temu_xlsx.py） | `uv run --with openpyxl python …` |

## 三、采集协议（推荐一条命令；六步在代码里强制，agent 无法跳步）

```
node <源码>/hands/act/collect.js --tab <tabId> --pid P --wid W --target N --out f.json
```
内部强制顺序：①闸门（封锁冷却/日限拒绝）②封锁签名检查（硬封锁即记账退出）③温启（目标页 0 卡时先种 cookie）④限额裁剪（剩余不足自动降目标，绝不超限）⑤站点配方滚采（`<源码>/recipes/temu/accumulate_human.js`，真实滚轮+拟人点击+断点续采）⑥验收（唯一 ID/三硬字段零缺失）+ 记账。

**手动细控才拆步**：`guard.js --check/--gate/--warmup/--block/--unblock/--collected`（各子命令见文件头注释）。轻量单屏采集也可用 `harvest` 工具。批间冷却 45~120s、单次 ≤300 条由守卫默认值约束（seeds 可调）。

## 四、封锁处置协议（被封时按此走，禁止自由发挥）

**信号分级**：
- **硬封锁**：URL 出现 `bgn_no_access.html` / 验证页 / captcha → 立即停止一切该站请求，`guard.js --host <站> --block 20`（≥20 分钟冷却），期间**零请求**——每次重试都在延长封锁。
- **软信号**：SW 离线墙（"No internet connection"）→ 先 curl 同 URL 对照：curl 通 = 浏览器侧问题；curl 不通 = 检查代理/网络（**先问用户是否在动代理/VPN**，再谈风控——本次教训）；都不是才按封锁处理。
- **恢复**：冷却到期 → `--unblock` → 温启 → 轻量试水（≤40 条）→ 正常采集。

**pi 等其他 agent 上被封的通用根因**：站点协议知识没跟机器走（技能/种子里有，但 agent 没读）。解法已固化：本技能第三节 + `references/temu.md` + `hands/act/`（守卫代码随 scrader 分发，装了就有）。**不要把本机 experiences 笔记当可迁移知识——它只做本机增量**，通用协议以技能和 seeds 为准。

## 五、铁律（违反必踩坑）

1. **Jev 探活一次再进循环**；Jev 只在给定候选中选，选项质量决定决策质量。
2. **节奏放慢**：翻页 2~6s 抖动、批间冷却、关键词间留冷却；等距间隔是机器指纹。
3. **读取走 DOM**（harvest/evaluate 零输入事件）；拟人动作只花在必要处。
4. **坐标**：cua click x,y = get_window_state PNG 像素空间，坐标与尺寸必须同源；每动作前重取几何。
5. **Chromium 拒收后台输入**：cua 动作一律 `delivery_mode:"foreground"`。
6. **失败必须有熔断**：页错显式抛出、坐标 NaN 拒点、未导航成功绝不 history.back()、滚动停滞即收手——失败样本喂给风控比慢更致命。
7. **locale 变体**：同站不同入口 UI 语言不同，按钮/字段匹配一律双语正则（见 references/temu.md）。

## 深度资料

- **Temu 专篇**（页面特性/封锁签名表/locale 变体/采集参数/验收基准）：`references/temu.md` —— 任何 Temu 任务**先读它**
- 架构细节：仓库 `docs/ARCHITECTURE.md`；act 层用法：`hands/act/act.js` 文件头注释
