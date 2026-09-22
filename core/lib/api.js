// core/lib/api.js — Agent API 工具表（MCP tools/list 的单一来源）
'use strict';

const S = {
  tabId: { type: 'number', description: '目标标签页 id（list_tabs 获取）；省略则用当前活动标签页' },
};
const TOOLS_DEF = [
  { name: 'status', description: '查看 scrader 连接状态（扩展是否连上桥接）', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_tabs', description: '列出浏览器所有标签页', inputSchema: { type: 'object', properties: {} } },
  { name: 'open_tab', description: '新建标签页打开 URL', inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean', description: '是否置前，默认 true' } }, required: ['url'] } },
  { name: 'close_tab', description: '关闭标签页', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'activate_tab', description: '切换到指定标签页', inputSchema: { type: 'object', properties: { tabId: { ...S.tabId } }, required: ['tabId'] } },
  { name: 'navigate', description: '在标签页内导航到 URL（受扩展 allowlist 约束）', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: S.tabId }, required: ['url'] } },
  {
    name: 'evaluate', description: '在页面主环境执行任意 JS（支持 async/await），返回 JSON 结果。页面 CSP 禁止 eval 时自动改走 chrome.debugger(CDP)。适用于自定义抓取逻辑（选择器、滚动循环、合并去重等）',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JS 表达式或语句体（例：return document.title）' }, tabId: S.tabId, world: { type: 'string', enum: ['MAIN', 'isolated'] }, useDebugger: { type: 'boolean', description: '强制用 CDP Runtime.evaluate' } },
      required: ['code'],
    },
  },
  { name: 'read_page', description: '读取页面标题/URL/可见文本（≤200KB）', inputSchema: { type: 'object', properties: { tabId: S.tabId } } },
  { name: 'snapshot', description: '页面交互元素快照（可点击/可输入元素 + CSS 选择器 + 文本），用于无截图定位元素', inputSchema: { type: 'object', properties: { tabId: S.tabId } } },
  { name: 'click', description: '点击元素。定位二选一：selector（哈希类复用严重的站点不可靠）或 text（按精确可见文本定位：优先带 role=button 祖先、其次最接近视口水平中心者，可避开侧边栏同名链接——Temu 类站点推荐）。默认受信输入（isTrusted=true）+ 拟人化（曲线轨迹/坐标抖动/按压间隔），失败降级合成事件', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string', description: '按精确文本定位，与 selector 二选一' }, tabId: S.tabId, trusted: { type: 'boolean' }, humanize: { type: 'boolean' } }, required: [] } },
  { name: 'fill', description: '向输入框填入文本。默认受信：真实点击聚焦 + Ctrl+A 全选 + 逐字符随机节奏键入（中文等多字节字符自动 insertText）；trusted:false 用合成事件（原生 value setter）', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: S.tabId, trusted: { type: 'boolean' }, humanize: { type: 'boolean' } }, required: ['selector', 'value'] } },
  { name: 'press_key', description: '按键（Enter/Tab/Escape/ArrowDown/单字符）。默认受信输入（真实 keyDown/keyUp + 随机间隔），失败降级合成事件', inputSchema: { type: 'object', properties: { key: { type: 'string' }, tabId: S.tabId, trusted: { type: 'boolean' }, humanize: { type: 'boolean' } }, required: ['key'] } },
  { name: 'scroll', description: '滚动页面。默认受信拟人化滚轮（mouseWheel 事件序列：随机档位/间隔、偶尔回滚、鼠标漂移；isTrusted=true）。untilText 或 untilSelector：滚到该元素进入视口即停（虚拟列表友好，每轮现查元素）；否则按 mode by 增量 / to 绝对位置滚一次。humanize:false 提速', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['by', 'to'] }, x: { type: 'number' }, y: { type: 'number' }, untilText: { type: 'string', description: '滚到此文本的元素进入视口' }, untilSelector: { type: 'string', description: '滚到此选择器元素进入视口' }, timeoutMs: { type: 'number', default: 30000 }, trusted: { type: 'boolean' }, humanize: { type: 'boolean' }, tabId: S.tabId } } },
  { name: 'wait_for', description: '等待文本或选择器出现（页内轮询）', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, timeoutMs: { type: 'number', default: 10000 }, tabId: S.tabId } } },
  { name: 'extract', description: '结构化提取：按选择器取重复元素，返回 text/href 及自定义子字段', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, fields: { type: 'object', description: '子字段映射 {字段名: 子选择器}' }, limit: { type: 'number' }, tabId: S.tabId }, required: ['selector'] } },
  { name: 'screenshot', description: '截取标签页可视区域（返回 base64 图片）', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['jpeg', 'png'] }, tabId: S.tabId } } },
  {
    name: 'decide', description: '快速决策：把浏览器状态和候选动作交给 Jev（默认顺序 TypeSafe 官方 api.typesafe.ai → OpenRouter typesafe/jev-1.13），Jev 不可用自动回退 LLM。Key 配置：SCRADER_PROVIDERS 指向的文件 → 用户配置目录 config.json（Windows %APPDATA%\\scrader_mcp，其余 ~/.config/scrader_mcp）；或 SCRADER_TYPESAFE_API_KEY 等环境变量。协议与 jev-for-chrome 相同：{state, questions} → {answers:{qid:{choice,probabilities,confidence}}}',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'object', description: '页面/任务状态（task、page.url、page.text、elements、recent_actions…）' },
        questions: { type: 'object', description: '决策问题：每个 {type:"choice", criteria:{选项:说明}, instructions:{…}}；可加 goal_done / stuck 的 noul 检查' },
      },
      required: ['questions'],
    },
  },
  {
    name: 'harvest', description: '通用列表采集（内置抗虚拟列表算法）：小步滚动+停滞检测+按稳定ID合并去重+慢速二遍补采+图片规范化（取卡片内最大产品图，自动排除小角标/占位图）。适用于任何商品列表/搜索结果/瀑布流。返回 items + stats（null_* 空值计数是站点改版的预警信号）。站点技巧先查用户配置目录 experiences/ 笔记',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: S.tabId,
        itemSelector: { type: 'string', description: '条目锚点选择器，如 a[href*="-g-"]' },
        maxItems: { type: 'number', description: '上限，默认 40；0 = 不限（滚到底）' },
        cardLevels: { type: 'number', description: '锚点向上几层是完整卡片，默认 4' },
        stableIdPattern: { type: 'string', description: '稳定ID正则（从 href 提取，如 "-g-(\\\\d+)\\\\.html"）；缺省自动取 href 中 4 位以上数字' },
        fields: {
          type: 'array',
          description: '从卡片文本提取的字段规则',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, pattern: { type: 'string', description: '正则，第 1 个捕获组为值' }, kind: { type: 'string', enum: ['int', 'string'] } },
            required: ['key', 'pattern'],
          },
        },
      },
      required: ['itemSelector'],
    },
  },
  {
    name: 'desktop',
    description: '桌面原生应用自动化（可选子系统，需本机 cua-driver 守护进程）：代理 `cua-driver call <method> <json>`。方法全集用 desktop({method:"list_tools"}) 查；常用：list_apps / list_windows / get_window_state(pid[,window_id]) 返回 UIA 元素树（click 优先用其 element_index，后台 UIA Invoke，不抢焦点不动光标，最小化窗口也可点）/ click / type_text / press_key / hotkey / scroll / set_value(UIA ValuePattern) / invoke_menu / launch_app(SW_SHOWNOACTIVATE 不抢焦点) / kill_app / get_desktop_state(截图) / clipboard_read / verify_state。浏览器页面操作仍用 scrader 本体工具（DOM 精确定位）',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'cua-driver 方法名（list_tools 可查全集）' },
        args: { type: 'object', description: '该方法的参数对象（schema 见 describe 或方法文档）' },
      },
      required: ['method'],
    },
  },
];

module.exports = { TOOLS_DEF };
