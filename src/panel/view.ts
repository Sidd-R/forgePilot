import * as vscode from 'vscode';

/** Panel markup: styles plus shell elements. */
export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
    );
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 10px 12px; margin: 0; }
#card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; }
#card .ctx-head { color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
#card .ctx-row { display: flex; gap: 8px; padding: 1px 0; }
#card .ctx-file { font-family: var(--vscode-editor-font-family); white-space: nowrap; }
#card .ctx-reason { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#card .ctx-tokens { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; }
#card .ctx-empty { color: var(--vscode-descriptionForeground); }
#log { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.msg { white-space: pre-wrap; word-break: break-word; line-height: 1.45; font-size: 13px; }
.msg-tool { font-family: var(--vscode-editor-font-family); font-size: 11.5px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 8px; }
.msg-approval { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 4px; padding: 4px 8px; font-size: 12px; }
.msg-notice { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; }
#prompt { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px 8px; font-family: inherit; font-size: 13px; resize: vertical; }
#prompt:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.row button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; padding: 4px 12px; cursor: pointer; }
.row button:hover { background: var(--vscode-button-secondaryHoverBackground); }
#send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
#send:hover { background: var(--vscode-button-hoverBackground); }
#send:disabled { opacity: 0.6; cursor: default; }
#complete { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; display: none; margin-top: 4px; }
#complete div { padding: 4px 8px; cursor: pointer; font-size: 12px; }
#complete div:hover { background: var(--vscode-list-hoverBackground); }
.msg pre { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 8px; overflow-x: auto; font-size: 11.5px; }
.msg code { font-family: var(--vscode-editor-font-family); font-size: 11.5px; }
.msg p { margin: 0 0 6px; } .msg p:last-child { margin-bottom: 0; }
.msg table { border-collapse: collapse; font-size: 12px; } .msg th, .msg td { border: 1px solid var(--vscode-panel-border); padding: 2px 8px; }
#overlay { display: none; position: fixed; inset: 0; background: var(--vscode-sideBar-background); padding: 10px 12px; overflow-y: auto; }
#overlay.open { display: block; }
#overlay .hist-item { padding: 6px 8px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
#overlay .hist-item:hover { background: var(--vscode-list-hoverBackground); }
#overlay .hist-when { color: var(--vscode-descriptionForeground); font-size: 11px; }
#overlayBack { margin-bottom: 8px; }
</style></head>
<body>
<div id="card"><span class="ctx-empty">Context will appear here.</span></div>
<div id="log"></div>
<textarea id="prompt" rows="3" placeholder="Ask anything (@file, @symbol)"></textarea>
<div id="complete"></div>
<div class="row">
<button id="send">Send</button>
<button id="cancel">Cancel</button>
<button id="newchat">New Chat</button>
<button id="history">History</button>
<button id="undo1">Undo Last</button>
<button id="undoRun">Undo Run</button>
</div>
<div id="overlay"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
