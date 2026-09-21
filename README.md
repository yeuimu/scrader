<p align="center"><img src="chrome-extension/icons/icon128.png" width="96" alt="scrader icon"></p>

# scrader

**S**pider + sc**r**aper — browser operations & web scraping as [MCP](https://modelcontextprotocol.io) tools for any AI agent (ZCode / Claude Desktop / Cursor / Cline …).

[中文文档](README.zh-CN.md)

## Highlights

- **18 MCP tools** — tabs, page reading, `evaluate` (arbitrary JS), screenshot …
- **Trusted humanized input** — click / fill / scroll go through `chrome.debugger` (`isTrusted=true`) with bezier mouse paths, jitter, per-key typing rhythm; falls back to synthetic events automatically
- **`harvest`** — generic list scraper: anti-virtual-list scrolling, stable-id dedupe, two-pass gap fill, image normalization
- **`decide`** (optional) — Jev fast decisions: TypeSafe → OpenRouter → any OpenAI-compatible LLM
- **No CDP port 9222** — no "allow debugging" consent prompts, ever

## Architecture

```
Agent (MCP stdio) ── scrader-mcp.js ── HTTP 127.0.0.1:7827 ── bridge.js ── WebSocket ── Chrome extension (MV3)
```

The extension owns the browser; the bridge auto-spawns when needed.

## Install

1. **Extension** — `chrome://extensions` → Developer mode → *Load unpacked* → select `chrome-extension/`
2. **MCP server** — add to any MCP client config:
   ```json
   {
     "mcp": {
       "servers": {
         "scrader": {
           "command": "node",
           "args": ["<repo-path>/mcp-server/scrader-mcp.js"]
         }
       }
     }
   }
   ```
   Or without cloning — `npx -y github:yeuimu/scrader` (Windows clients: wrap with `cmd /c npx ...`).
3. **Decision key** (optional, only for `decide`) — copy `mcp-server/providers.example.json` to:
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

## Security

Bridge binds `127.0.0.1` only · keys live only in the user config dir (never in git) · domain allowlist on the options page · audit log via `SCRADER_LOG=<file>`.

## Dev

```bash
node mcp-server/selftest.js     # full-chain selftest, no Chrome needed
node mcp-server/scrader-mcp.js --check
```

MIT
