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

## Using ForgePilot

- **Agent panel:** click the ForgePilot icon in the activity bar (or `Cmd/Ctrl+Alt+L`).
  Each prompt shows a *Context picked* card (files, why each was chosen, token budget),
  then the streamed reply, every tool the agent ran, and review outcomes. The header
  shows the active model, configured fallbacks, and a link to the TrueForge session.
  `Stop` (or `Cmd/Ctrl+Alt+Backspace`, or the status bar spinner) cancels the run and
  rejects any open review.
- **Inline edit:** select code (or put the cursor in a function) and press `Cmd/Ctrl+Alt+K`.
- **Review:** proposed hunks are staged unsaved in the editor with green/red highlights.
  Use the CodeLens buttons (`Accept hunk n/m`, `Reject`, `Accept all`, `Reject all`).
  Nothing is written to disk until you decide. `Undo last` / `Undo run` restore files.

## Validate

```bash
npm run validate:offline   # typecheck, lint, build, unit tests (no TrueForge needed)
npm run validate           # + live integration tests (needs TrueForge running)
npm run preview:panel      # renders the panel (dark/light) to out/preview/*.png via headless Chrome
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
