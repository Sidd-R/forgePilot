import { PANEL_CSS } from './styles';

const isMac = typeof process !== 'undefined' && process.platform === 'darwin';
const INLINE_KEY = isMac ? '⌘⌥K' : 'Ctrl+Alt+K';

/** Panel shell markup. vscode-free so the preview script can render it. */
export function panelMarkup(scriptSrc: string, nonce: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>${PANEL_CSS}</style></head>
<body>
<div id="meta"><span class="dot off" id="modelDot"></span><span class="model" id="modelName" title="Model used for the next run (Settings: forgepilot.models.primary)">No model configured</span><span class="fallbacks" id="fallbacks"></span><a id="sessionLink" style="display:none" title="Open this run in the TrueForge UI">TrueForge session ↗</a></div>
<div id="scroll">
  <div id="empty">
    <h3>Ask ForgePilot to change your code</h3>
    Describe the change. ForgePilot finds the relevant files, proposes edits, and you review every hunk before anything is written.
    <button class="example" data-prompt="Explain how configuration is loaded in this project.">Explain how configuration is loaded in this project.</button>
    <button class="example" data-prompt="Add a test for the most recently changed function.">Add a test for the most recently changed function.</button>
    <div>Mention code with <code>@file name</code> or <code>@symbol name</code>. For a quick single-function edit, select code and press <kbd>${INLINE_KEY}</kbd>.</div>
  </div>
  <div id="log"></div>
</div>
<div id="working"><span class="spinner"></span><span id="workingText">Working…</span></div>
<div id="composer">
  <div id="complete"></div>
  <textarea id="prompt" rows="3" placeholder="Describe a change…  (@file, @symbol)"></textarea>
  <div class="bar">
    <span class="hint" id="hint">⏎ send · ⇧⏎ newline</span>
    <button class="link-btn" id="undo1" title="Restore the file changed by the last accepted proposal" disabled>Undo last</button>
    <button class="link-btn" id="undoRun" title="Restore every file changed in the last run" disabled>Undo run</button>
    <button id="send">Send</button>
  </div>
  <div id="usage" title="Token usage reported by TrueForge for each model call"></div>
</div>
<div id="overlay"></div>
<script nonce="${nonce}" src="${scriptSrc}"></script>
</body></html>`;
}
