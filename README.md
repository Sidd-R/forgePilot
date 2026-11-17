# ForgePilot

Thin-client VS Code coding-agent extension. The agent loop runs on a local
**TrueForge** harness; this extension provides the editor UI and the MCP tools
the agent calls. Built from scratch for the Techfest IIT Bombay TrueFoundry
Forge-a-thon (Round 1). Team TM-55B1C632C89.

Starting point: built from scratch, no fork, no upstream agent loop.

## Prerequisites

- Node 22.14+
- VS Code 1.90+
- Python 3 + pytest (for the Flask demo tasks)

## Setup

```bash
npm install
npm run build
```

Start TrueForge (in another terminal). The loopback allowlist is required:
TrueForge refuses to call MCP servers on `127.0.0.1` without it.

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
```

Add models under Settings → Models in the TrueForge UI
(`http://localhost:8790`), e.g.:

```text
provider: custom
name: muse
base_url: https://<your-openai-compatible-endpoint>/v1
api_key: <your-key-here>   # never commit keys; placeholders only
```

Then launch the extension (`F5` in VS Code) and run
**ForgePilot: Load Agent Definitions**.

## Validate

```bash
npm run validate
```

## How it works

- `src/trueforge/` — SDK wrapper: sessions, streamed turns, approvals, retry/fallback.
- `src/mcp/` — local MCP server on `127.0.0.1` with bearer auth; editor tools.
- `src/context/` — lexical + symbol + git-history context engine with a token budget.
- `src/edits/` — the only disk-write path: proposal store, hunk review, undo.
- `src/inline/` — keybinding inline edit with tool + fenced-block fallback.
- `src/panel/` — agent panel webview.

No model provider is ever called directly; only TrueForge talks to models.

The extension uses TrueForge's REST + SSE API directly instead of the
TypeScript SDK (the gate allows either): the published SDK cannot load under
Node's CommonJS resolver.
