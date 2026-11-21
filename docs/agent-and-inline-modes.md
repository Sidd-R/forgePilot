# How Agent Mode and Inline Mode Work

This describes how forgePilot's two modes run, from the command you trigger to the bytes written on disk.

- **Agent mode:** the sidebar panel, using the `forgepilot-coder` agent.
- **Inline mode:** Ctrl/Cmd+Alt+K or the editor context menu, using the `forgepilot-inline` agent.

---

## Shared foundation (both modes)

### 1. The host is built lazily

`src/extension.ts` `ensureHost` → `src/host.ts`. The host is built the first time you run any command:

- It indexes the workspace with the code index and BM25 (`src/context/`).
- It starts the local MCP server on `127.0.0.1` with a random bearer token for each session (`src/mcp/server.ts`).
- It registers that server with TrueForge as `forge-editor` (`src/trueforge/setup.ts` `registerMcpServer`). The registration sends the token as an `Authorization` header, so TrueForge can call back into the editor.

### 2. TrueForge runs the agent loop, and the extension never does

The extension only:

- creates a session (`POST /api/v1/sessions` with the agent spec, `src/trueforge/client.ts`)
- starts a turn and reads its SSE stream (`streamTurn`)
- answers approval pauses (`answerApproval` → a `user.tool_approval` event)
- cancels (`POST …/cancel`)

TrueForge decides which tools to call. It calls the read-only tools (`read_file`, `search_code`, `find_text`, `get_diagnostics`, `git_diff`, `list_symbols`) directly over MCP without asking.

### 3. Approval pauses are where the editor takes part

Both agent specs set `require_approval_for_tools: [propose_edit, run_command]`. When the model calls either tool, TrueForge emits `tool.approval_required` and pauses the turn.

### 4. The shared turn handler

`src/flows/turns.ts` `createTurnHandler` is used by both modes. For each streamed event it does the following:

- **`model.message` / `.delta`:** merges them into a `MessageBuffer` (`src/flows/messages.ts`). Text concatenates, and tool-call arguments are joined by call id or index. This is how it later rebuilds the full arguments of a tool call that arrived in fragments.
- **`tool.response`:** for tools that don't need approval, it adds a transcript line such as "read X".
- **`tool.approval_required`:** it looks up the tool call by `sourceEventId` + `toolCallId` and routes it:
  - **`propose_edit`** → `handleProposeEdit`:
    1. `prepareProposals` (`src/mcp/tools/propose_edit.ts`) parses the arguments and path-jails each file. It builds hunks either from `old_text/new_text` blocks (whitespace-tolerant matcher) or from whole-file `content`.
    2. It stages the hunks in the `ProposalStore` under a hash of the call arguments. This is all-or-nothing: if any file fails, nothing is staged and the model receives a deny reason it can retry from.
    3. It opens one review per file, all at once (`Promise.all`). It then sends **one** answer: allow if at least one hunk was accepted, otherwise deny with "User rejected every hunk."
  - **`run_command`** → asks you to allow once, allow for the session, or deny. Commands allowed for the session are remembered and auto-approved.
  - **Anything else** → denied.

### 5. The review UI

`src/edits/review.ts` `ReviewController.open`:

- It writes a red/green layout into the **unsaved buffer**: removed lines sit above added lines, each hunk has Accept/Reject CodeLenses, and auto-save is turned off while the review is open.
- Each decision restages the buffer.
- When every hunk is decided, `finish` rebuilds the text from the original plus only the accepted hunks, and saves only if something was accepted.
- A brand-new file gets an untitled preview with a "Create file / Reject" prompt instead.

### 6. How the write actually happens

Allowing the approval is not what writes the file:

1. TrueForge receives "allow" and then actually *calls* `propose_edit` over MCP.
2. The tool handler (`applyPreparedProposal`) hashes the arguments again and finds the recorded decision. If no review happened, it refuses.
3. `applyDecidedProposal` checks that the file hasn't changed since the review, then writes through `src/edits/proposals.ts`, the only module allowed to write to disk.
4. The tool result tells the model which hunks were applied and which were rejected ("do not resend unchanged").

### 7. Retries and fallback

`src/trueforge/resilience.ts` `runTurnResilient`:

- Every attempt gets a fresh session.
- Errors like 429, 5xx, timeouts, a dropped stream or silence are retried twice, after 1s and then 3s.
- Errors like 401/403, an unknown model or connection refused skip straight to the next model in `fallbackModels`.
- If the stream goes silent for 120s it is aborted. That timer is turned off while the turn is paused for approval, because a long review must not trigger retries.
- `streamTurn` also resubscribes with `after_event_id` when the HTTP stream closes. During a paused turn it keeps waiting (up to about 30 minutes); for a dropped connection it retries up to 5 times.

---

## Agent mode (sidebar panel)

**Entry point:** `PanelHost.runPrompt` (`src/panel/host.ts`)

1. **Guards.** It does nothing if a run is already going, an inline edit is busy, or no primary model is set. Otherwise it marks the host busy and clears `cancelled`.
2. **Context pack:**
   - `parseMentions` resolves `@file foo` / `@symbol bar` to real paths and symbols.
   - `buildPack` (`src/context/pack.ts`) ranks chunks by: BM25 → exact symbol/filename boosts → editor locality (open or active files) → partner files (the matching test and doc files). The result is trimmed to the token budget (default 6000).
   - A summary card (which files, why, how many tokens) is added to the transcript.
3. **Agent spec:** `agents/forgepilot-coder.yaml` is loaded with the configured model filled in. It has:
   - all `forge-editor` tools, with `forge-workspace` deferred
   - subagents enabled, an iteration limit of 60, and compaction at 60k tokens
   - instructions to read before editing, batch all files into a single `propose_edit`, check diagnostics after each edit, run tests (venv-aware, `PYTHONPATH=./src`), and finish with a summary
4. **`runAgentTurn`** (`src/flows/agent.ts`). The input is `renderPack(pack, prompt)`: the chunks with `path:line` headers, the repo outline, then the request.
   - **First prompt:** goes through `runTurnResilient` with the whole fallback chain.
   - **Follow-up prompts:** reuse the panel's `sessionId` and call `streamTurn` directly with no fallback, so the conversation keeps its context. If a turn ends in `error`, the session id is cleared and the next prompt starts fresh with full fallback.
5. **Streaming UI.** Transcript events are queued and flushed to the webview every 50ms. Token usage comes from a `UsageMeter` (`src/flows/usage.ts`) and is shown for the run and for the whole chat. Chats are saved in `ChatHistory`.
6. **Reviews.** Each finished file review adds a line like "path: N accepted, M rejected" and sets `host.lastRunId` for Undo. The run id is the TrueForge turn id, so **Undo Last** reverts the most recent checkpoint and **Undo Run** reverts the whole turn.

**What the model does during a run is entirely up to TrueForge:** search, read, propose, (you review), check diagnostics, run tests (you approve), summarise.

---

## Inline mode (Ctrl/Cmd+Alt+K or the editor context menu)

**Entry point:** `inlineEdit` in `src/extension.ts`, which sets the busy flag and then calls `runInlineCommand` (`src/inline/command.ts`).

1. **Choosing the target** (`captureTarget`):
   - If you have a selection, that is the target.
   - With no selection, the index chunk under the cursor that has a symbol (the enclosing function or class) is used, and it gets selected visibly.
   - It also captures about 40 lines before and after as read-only context.
2. **Instruction.** An input box asks for the change and shows `path:start-end`. It stays open if focus moves away.
3. **Loader UI** (`src/inline/marker.ts`):
   - `PendingMarker` highlights the target lines and shows an italic "✦ ForgePilot: …" label after the first line.
   - `LiveStatus` updates both the notification and that label with the current stage, elapsed seconds (ticks every 1s, at most about 5 redraws per second), and token counts.
   - `describeActivity` (`src/inline/activity.ts`) turns the partially streamed message into text like "Writing the edit… (812 chars)" or the last ~90 characters of the model's narration.
4. **Agent spec.** `agents/forgepilot-inline.yaml` exposes **only** `propose_edit`, has no subagents and an iteration limit of 6. Its instructions:
   - edit only the selected range
   - send one small `old_text/new_text` edit per changed location, so a docstring change and a logic change become separate hunks (this is what Task A's "2+ hunks" relies on)
   - quote `old_text` exactly from the prompt
   - if tools can't be used, reply with a single fenced block
5. **`runInlineEdit`** (`src/inline/controller.ts`):
   - The input is `buildInlineInput`: the instruction, the file, the selected lines in a fence, and the before/after context labelled read-only.
   - It runs through `runTurnResilient`, so it gets the same retry and fallback behaviour as agent mode.
   - It wraps the shared turn handler with inline-specific rules:
     - **One review per turn.** `proposalGate` denies any extra `propose_edit` once a review for that turn has finished.
     - **Early stop.** After you decide, `stopTurn` is set. When the next `tool.response` arrives (meaning the approved tool has done its write), it calls `client.cancel` so you don't wait for a summary or a pointless retry. It waits for that response deliberately: cancelling at approval time could lose the write. A cancel that happened this way is not reported to you as "cancelled".
     - **`run_command` is always denied.**
     - The review wrapper in `command.ts` pauses the loader and removes the marker as soon as the diff colours appear.
6. **Fenced-block fallback** (`runFencedFallback`, for models that never opened a review):
   - It takes the first fenced block from the last message (`src/inline/fenced.ts`).
   - It re-reads the file and refuses if the selected lines changed meanwhile.
   - It splices the block into the selection, builds a proposal with run id `inline-<session>`, and opens the same hunk review. If you accept, it writes through `applyDecidedProposal`.
   - If there is no tool call and no block, it reports the last deny reason (for example a matcher failure).
7. **Diagnostics repair loop** (at most 2 rounds):
   - Diagnostics are captured before the edit. After an accepted edit, `selectNewErrors` keeps only **errors that weren't there before**.
   - If any exist, it sends a follow-up turn in the **same session**: "Your edit introduced these errors… fix with propose_edit". That fix goes through review again.
   - The loop stops once there are no new errors, if the model proposes nothing, or if the turn fails.
8. **Outcome:**
   - `applied` → a notification with token usage and an **Undo** button (`forgePilot.undoLast`)
   - `rejected` / `cancelled` → "file is unchanged"
   - `failed` → shown through notices

---

## Cancel (both modes)

`cancelActive` (`src/extension.ts`) does these steps in order:

1. Sets `host.cancelled = true` first, so a run that is still creating its session stops before its first turn.
2. Kills any child process from `run_command`.
3. Closes every open review as Reject All, which restores the original buffer text.
4. Calls `sessions.cancel`.

`runTurnResilient` checks `isCancelled` before every attempt, sleep and fallback and stops with `TurnCancelledError`. Inline mode's own cancel button does the same review clean-up, so a pending review can't leave the loader stuck.

---

## Main differences

| | Agent mode | Inline mode |
|---|---|---|
| Agent spec | `forgepilot-coder` (all tools, subagents, 60 iterations) | `forgepilot-inline` (`propose_edit` only, 6 iterations) |
| Input | BM25 context pack, ~6000 tokens, plus @mentions | Selection plus ±40 lines of read-only context |
| Scope | Many files in one batched review | Selected range only, one review per turn |
| Commands | `run_command` with once / session / deny | Always denied |
| Session | Kept across follow-up prompts | One per edit, reused only for repair turns |
| Ending | Model writes a summary and `turn.done` | Cancelled early once the decided tool has responded |
| Fallbacks | Fallback model chain | Fallback model chain, fenced-block fallback, up to 2 diagnostics repair rounds |
| UI | Webview transcript batched every 50ms | Progress notification plus in-editor marker label |
