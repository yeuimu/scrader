<p align="center"><img src="hands/browser/extension/icons/icon128.png" width="96" alt="scrader icon"></p>

# scrader

**S**pider + sc**r**aper — browser operations & web scraping as [MCP](https://modelcontextprotocol.io) tools for any AI agent (ZCode / Claude Desktop / Cursor / Cline …).

[中文文档](README.zh-CN.md)

## Layout

```
core/  brain: MCP API + decide + routing
hands/ effectors: browser(extension+bridge+harvest) / cua(client+adapter+glide)
eyes/  gaze: screenshot → YOLO+OCR → elements
motion/ humanized trajectory (single source, dual backends)
docs/ARCHITECTURE.md for details
```

## Highlights

- **18 MCP tools** — tabs, page reading, `evaluate` (arbitrary JS), screenshot …
- **Trusted humanized input** — click / fill / scroll go through `chrome.debugger` (`isTrusted=true`) with bezier mouse paths, jitter, per-key typing rhythm; falls back to synthetic events automatically
- **`harvest`** — generic list scraper: anti-virtual-list scrolling, stable-id dedupe, two-pass gap fill, image normalization
- **`decide`** (optional) — Jev fast decisions: TypeSafe → OpenRouter → any OpenAI-compatible LLM
- **No CDP port 9222** — no "allow debugging" consent prompts, ever

## Architecture

```
Agent (MCP stdio) ── core/index.js ── HTTP 127.0.0.1:7827 ── bridge.js ── WebSocket ── Chrome extension (MV3)
```

The extension owns the browser; the bridge auto-spawns when needed.

## Install

0. **China-network one-liner** (recommended for CN; detects and installs what's missing — Node / Python deps / cua-driver — all from domestic mirrors) —
   ```
   irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
   ```
   Add `-DryRun` to rehearse (in-repo: `powershell -ExecutionPolicy Bypass -File scripts\cn-setup.ps1 -DryRun`).
1. **Extension** — `chrome://extensions` → Developer mode → *Load unpacked* → select `hands/browser/extension/`
2. **MCP server** — add to any MCP client config:
   ```json
   {
     "mcp": {
       "servers": {
         "scrader": {
           "command": "node",
           "args": ["<repo-path>/core/index.js"]
         }
       }
     }
   }
   ```
   Without cloning — CN: `npx -y git+https://gitee.com/yeuimu/scrader.git` (overseas: `npx -y github:yeuimu/scrader`; Windows clients: wrap with `cmd /c npx ...`).
3. **Decision key** (optional, only for `decide`) — copy `core/providers.example.json` to:
   - Windows: `%APPDATA%\scrader_mcp\config.json`
   - macOS / Linux: `~/.config/scrader_mcp/config.json`

Restart the agent session — tools appear as `mcp__scrader__*`.

## Tools

| Category | Tools |
|---|---|
| Tabs | `status` `list_tabs` `open_tab` `close_tab` `activate_tab` `navigate` |
| Read | `read_page` `snapshot` `extract` `screenshot` |
| Act | `evaluate` `click` `fill` `press_key` `scroll` `wait_for` |
| Scrape / decide | `harvest` `decide` |
| Desktop (optional) | `desktop` |

### harvest example

```js
harvest({
  itemSelector: 'a[href*="-g-"]',   // Temu product cards
  maxItems: 200,
  fields: [
    { key: 'price',     pattern: '(\\d[\\d,]*)円', kind: 'int' },
    { key: 'soldCount', pattern: '已售([\\d,.]+[万K]?)件' },
  ],
})
// → { items: [...], stats: { count, null_price, uniqueImages, … } }
```

`stats.null_*` spiking = the site changed its markup — check the `experiences/` notes in the config dir.

## Desktop apps (optional)

`desktop` proxies the local [cua-driver](https://github.com/trycua/cua) daemon (`cua-driver call <method> <json>`) for native desktop automation — UIA element clicks that work in the background without stealing focus. Smart built-ins: `find_window({title})` locates a top-level window by title across all processes (dialog host pids change every launch); `set_text({pid,window_id,element_token,value})` writes text into native controls (UIA set_value → keyboard fallback, backslash-safe, verified by read-back); keyboard methods auto bring_to_front first. Install (PowerShell, CN mirror first): in-repo `powershell -ExecutionPolicy Bypass -File scripts\cn-setup.ps1` (cua-driver fetched from the Gitee Release mirror — verbatim redistribution of the official MIT package); or official channel (overseas) `irm https://cua.ai/driver/install.ps1 | iex; cua-driver autostart kick`. Then the tool lights up; without it, everything else keeps working. Browser pages stay on scrader's own DOM-level tools.

## Security

Bridge binds `127.0.0.1` only · keys live only in the user config dir (never in git) · domain allowlist on the options page · audit log via `SCRADER_LOG=<file>`.

## Dev

```bash
node test/selftest.js  # 或 npm run selftest     # full-chain selftest, no Chrome needed
node core/index.js --check
```

MIT

## Agent setup and usage

> Send the prompt below to any MCP-capable agent to install, configure and verify scrader. The usage decision tree and battle-tested rules live at `skills/scrader/SKILL.md` (copy it into the agent's skills directory for auto-triggering).

```text
Install and configure scrader (generic browser/desktop controller) — all from China-friendly mirrors, no GitHub needed:
0) One-shot bootstrap (detects what's missing and installs it: Node->npmmirror, Python deps->Tsinghua PyPI, cua-driver->Gitee mirror):
   irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
   (no uv? falls back to venv + Tsinghua pip, never force-installs uv; no npm? Node is installed to the user dir from npmmirror)
1) Open https://gitee.com/yeuimu/scrader/releases and download (overseas fallback: github.com/yeuimu/scrader/releases):
   - scrader-extension-<version>.zip (browser extension)
   - gaze-weights-<version>.zip (visual perception weights)
   - cua-driver-mirror-0.28.2-win-x64.zip (desktop driver CN mirror; skip if step 0 already installed it)
   (If asset zips are not yet attached: the source archive alone suffices — load the unpacked extension from hands/browser/extension/, and eyes/gaze/weights/ already contains all YOLO+OCR weights)
2) Extension: chrome://extensions -> Developer mode -> "Load unpacked" -> select the unzipped extension folder.
3) MCP config: add a server to your host's MCP config — command=node, args=["<sources>/core/index.js"] — then reload MCP.
4) decide (optional): ask me whether I have a TypeSafe Jev API key; if yes, copy <sources>/core/providers.example.json
   to the user config dir (Windows: %APPDATA%/scrader_mcp/, others: ~/.config/scrader_mcp/) as config.json and fill the key.
   The llm fallback accepts any OpenAI-compatible endpoint — in China use a DeepSeek/GLM baseUrl+apiKey.
5) cua-driver desktop automation (required) — pick one:
   CN mirror (recommended): powershell -ExecutionPolicy Bypass -File <sources>/scripts/cn-setup.ps1
   Official (overseas): $env:CUA_DRIVER_RS_VERSION="0.28.2"; irm https://cua.ai/driver/install.ps1 | iex
   then cua-driver autostart kick.
6) Perception weights: unzip gaze-weights-<version>.zip into <sources>/eyes/gaze/weights/ (YOLO icon detection + OCR weights).
   Python deps self-check (with uv): set UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple first, then
   uv run --with rapidocr-onnxruntime --with onnxruntime --with opencv-python-headless --with numpy python <sources>/eyes/gaze/gaze.py --help
   (no uv: <sources>/eyes/gaze/.venv/Scripts/python.exe gaze.py --help — cn-setup builds this venv automatically).
7) Verify: scrader status tool reports the extension connected; read_page works on any open page; desktop tool calls list_apps to confirm cua.
Proceed step by step; ask me before actions needing confirmation (extension load, key entry). Then follow skills/scrader/SKILL.md.
```
