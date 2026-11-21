// Renders the agent panel outside VS Code and screenshots it with headless
// Chrome: real markup + real dist/webview.js, fake theme + replayed fixture.
// Usage: npm run preview:panel -- [outDir]   (needs `tsc` + `npm run build` first)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { panelMarkup } = require('../out/src/panel/markup');

const root = path.resolve(__dirname, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'out', 'preview'));
fs.mkdirSync(outDir, { recursive: true });

const THEMES = {
  dark: { fg: '#cccccc', bg: '#181818', editor: '#1f1f1f', border: '#2b2b2b', muted: '#9d9d9d', input: '#313131', inputBorder: '#3c3c3c', button: '#0078d4', buttonFg: '#ffffff', secondary: '#313131', link: '#4daafc', error: '#f85149', warn: '#cca700', pass: '#2ea043', hover: '#2a2d2e', sel: '#04395e', warnBg: '#352a05', progress: '#0078d4', code: '#2b2b2b' },
  light: { fg: '#3b3b3b', bg: '#f8f8f8', editor: '#ffffff', border: '#e5e5e5', muted: '#717171', input: '#ffffff', inputBorder: '#cecece', button: '#005fb8', buttonFg: '#ffffff', secondary: '#e5e5e5', link: '#005fb8', error: '#e51400', warn: '#bf8803', pass: '#388a34', hover: '#f2f2f2', sel: '#e8e8e8', warnBg: '#fff8c5', progress: '#005fb8', code: '#f2f2f2' },
};

function themeCss(t) {
  return `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Consolas,monospace;
--vscode-foreground:${t.fg};--vscode-sideBar-background:${t.bg};--vscode-editor-background:${t.editor};--vscode-panel-border:${t.border};--vscode-descriptionForeground:${t.muted};
--vscode-input-background:${t.input};--vscode-input-foreground:${t.fg};--vscode-input-border:${t.inputBorder};--vscode-focusBorder:${t.button};
--vscode-button-background:${t.button};--vscode-button-foreground:${t.buttonFg};--vscode-button-hoverBackground:${t.button};--vscode-button-secondaryBackground:${t.secondary};--vscode-button-secondaryForeground:${t.fg};
--vscode-textLink-foreground:${t.link};--vscode-errorForeground:${t.error};--vscode-editorWarning-foreground:${t.warn};--vscode-testing-iconPassed:${t.pass};
--vscode-list-hoverBackground:${t.hover};--vscode-list-activeSelectionBackground:${t.sel};--vscode-list-activeSelectionForeground:${t.fg};
--vscode-inputValidation-warningBorder:${t.warn};--vscode-inputValidation-warningBackground:${t.warnBg};--vscode-progressBar-background:${t.progress};--vscode-textCodeBlock-background:${t.code};}`;
}

const pack = {
  totalTokens: 6240, budget: 8000,
  items: [
    { path: 'src/flask/cli.py', startLine: 1003, endLine: 1040, reason: 'matched "cli", "command" in routes_command', tokens: 410 },
    { path: 'src/flask/cli.py', startLine: 380, endLine: 460, reason: 'matched "command" in FlaskGroup', tokens: 520 },
    { path: 'tests/test_cli.py', startLine: 1, endLine: 60, reason: 'test partner of cli.py; co-changed in 41 commits', tokens: 380 },
    { path: 'docs/cli.rst', startLine: 300, endLine: 360, reason: 'doc partner of cli.py; section "Open a Shell"', tokens: 290 },
    { path: 'src/flask/config.py', startLine: 50, endLine: 120, reason: 'matched "config" in class Config', tokens: 450 },
  ],
};

const FIXTURES = {
  empty: [
    { type: 'meta', model: 'muse/muse-spark-1-3-contributor', fallbacks: ['muse/muse-spark-1-3'], sessionUrl: '', canUndo: false },
    { type: 'runState', running: false, startedAt: 0 },
  ],
  run: [
    { type: 'meta', model: 'muse/muse-spark-1-3-contributor', fallbacks: ['muse/muse-spark-1-3'], sessionUrl: 'http://localhost:8790/sessions/x', canUndo: true },
    { type: 'runState', running: true, startedAt: Date.now() - 74000 },
    { type: 'usage', run: '48.2k in (31.0k cached) · 2.1k out', chat: '61.9k in (31.0k cached) · 2.6k out', calls: 9 },
    { type: 'transcriptBatch', events: [{ kind: 'user', text: 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking secrets.' }] },
    { type: 'transcriptBatch', events: [
      { kind: 'context', text: JSON.stringify(pack) },
      { kind: 'notice', text: 'Primary model failed (401 invalid api key). Continuing with muse/muse-spark-1-3.' },
      { kind: 'text', id: 'm1', text: '' },
      { kind: 'text', id: 'm1', text: 'I\'ll look at how the built-in commands are registered ', delta: true },
      { kind: 'text', id: 'm1', text: 'in `FlaskGroup`, then add `config_command`.', delta: true },
      { kind: 'tool_call', tool: 'search_code', text: '"built-in command routes shell"' },
      { kind: 'tool_call', tool: 'read_file', text: 'src/flask/cli.py:1000-1060' },
      { kind: 'tool_call', tool: 'read_file', text: 'tests/test_cli.py:430-520' },
      { kind: 'approval', text: 'reviewing src/flask/cli.py, tests/test_cli.py, docs/cli.rst' },
      { kind: 'review', text: 'src/flask/cli.py: 3 accepted, 0 rejected' },
      { kind: 'review', text: 'tests/test_cli.py: 1 accepted, 0 rejected' },
      { kind: 'review', text: 'docs/cli.rst: 0 accepted, 1 rejected' },
      { kind: 'approval', text: 'command: PYTHONPATH=./src python -m pytest tests/test_cli.py -q' },
      { kind: 'text', id: 'm2', text: '**Done.** Changed:\n- `src/flask/cli.py` — new `config_command`, registered in `FlaskGroup`\n- `tests/test_cli.py` — masking test' },
      { kind: 'changes', text: JSON.stringify([
        { path: 'src/flask/cli.py', accepted: 3, rejected: 0, line: 590 },
        { path: 'tests/test_cli.py', accepted: 1, rejected: 0, line: 430 },
        { path: 'docs/cli.rst', accepted: 0, rejected: 1, line: 1 },
      ]) },
      { kind: 'status', text: 'done' },
    ] },
  ],
};

function page(theme, fixture) {
  const nonce = 'preview';
  const webview = 'file://' + path.join(root, 'dist', 'webview.js');
  let html = panelMarkup(webview, nonce);
  const stub = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:(m)=>console.log('post',JSON.stringify(m)),getState:()=>undefined,setState:()=>{}});</script>`;
  const replay = `<script nonce="${nonce}">const F=${JSON.stringify(fixture)};for(const m of F){window.postMessage(m,'*');}</script>`;
  // Headless Chrome clamps windows to >=500px; pin the page to sidebar width.
  html = html.replace('<style>', `<style>${themeCss(THEMES[theme])} html{width:${WIDTH}px;border-right:1px dashed #888}</style><style>`);
  html = html.replace('<script nonce', `${stub}<script nonce`).replace('</body>', `${replay}</body>`);
  return html;
}

const WIDTH = Number(process.env.PANEL_WIDTH ?? 360);
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
for (const theme of Object.keys(THEMES)) {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const file = path.join(outDir, `panel-${name}-${theme}.html`);
    fs.writeFileSync(file, page(theme, fixture));
    const png = file.replace(/\.html$/, '.png');
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
      `--screenshot=${png}`, '--window-size=500,860', '--virtual-time-budget=1500', `file://${file}`], { stdio: 'ignore' });
    console.log(png);
  }
}
