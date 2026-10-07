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

## Install (two-phase: minimal bootstrap → the agent finishes the rest)

**Phase 1 — bootstrap** (a human runs this once; installs exactly three things — Node ≥18, the skill, cua-driver — all from domestic mirrors):
```
irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
```
`-DryRun` rehearses. The installer is framework-free and prints a one-line pointer.

**Phase 2 — the agent completes it** (user says "finish installing per the scrader skill"): the skill's `references/install.md` runbook has the agent register MCP into its own host (`node scripts/register.js --agent pi`, table-driven), reconnect, then **auto-load the browser extension via cua** (chrome://extensions → dev mode → Load unpacked → folder dialog set_text — no manual browser steps left), and verify the full chain.

Without phase 1 — CN: `npx -y git+https://gitee.com/yeuimu/scrader.git` (overseas: `npx -y github:yeuimu/scrader`), then MCP config `{"command":"node","args":["<repo>/core/index.js"]}` in any client.

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

> Send the prompt below to any MCP-capable agent. The skill runbook (`skills/scrader/references/install.md`) holds the full agent-driven install — including auto-loading the browser extension via cua.

```text
Install and configure scrader (generic browser/desktop controller) — all from China-friendly mirrors:
1) Minimal bootstrap (installs exactly three things: Node >=18 / the skill / cua-driver), PowerShell:
   irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
2) Finish the rest per the skill at ~/.agents/skills/scrader/ (references/install.md runbook):
   register MCP into your host (node <sources>/scripts/register.js --agent <pi|zcode>, or manual per host format) -> reconnect session
   -> auto-load the browser extension via cua (chrome://extensions -> dev mode -> Load unpacked -> folder dialog set_text
     the absolute path <sources>\hands\browser\extension; dialog host pid changes every time — find_window first; set_text is backslash-safe)
   -> verify: status shows extension connected / read_page any page / desktop list_apps.
3) Optional (ask me): decide key (core/providers.example.json -> %APPDATA%/scrader_mcp/config.json,
   llm fallback accepts DeepSeek/GLM OpenAI-compatible endpoints); gaze vision deps (uv or venv + Tsinghua PyPI).
Proceed step by step; show me evidence per step. Then follow skills/scrader/SKILL.md.
```
