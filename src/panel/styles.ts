/** Panel stylesheet. Theme colors come from VS Code CSS variables only. */
export const PANEL_CSS = `
:root { --gap: 8px; --radius: 6px; --muted: var(--vscode-descriptionForeground); --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35))); }
* { box-sizing: border-box; }
html, body { height: 100%; } html { position: relative; }
body { min-width: 0; width: 100%; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 0; display: flex; flex-direction: column; overflow: hidden; }
button { font-family: inherit; font-size: 12px; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }

#meta { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted); min-height: 28px; }
#meta .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed, #3fb950); flex: none; }
#meta .dot.off { background: var(--vscode-errorForeground); }
#meta .model { min-width: 0; font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#meta .fallbacks { white-space: nowrap; }
#meta #sessionLink { margin-left: auto; white-space: nowrap; }

#scroll { flex: 1; overflow-y: auto; padding: 10px 12px 4px; }

#empty { color: var(--muted); font-size: 12px; line-height: 1.55; padding: 8px 2px; }
#empty h3 { color: var(--vscode-foreground); font-size: 13px; margin: 0 0 6px; font-weight: 600; }
#empty .example { display: block; text-align: left; width: 100%; background: var(--vscode-editor-background); color: var(--vscode-foreground); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; margin: 6px 0; font-size: 12px; }
#empty .example:hover { border-color: var(--vscode-focusBorder); }
#empty kbd { font-family: var(--vscode-editor-font-family); font-size: 11px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; }

.card { background: var(--vscode-editor-background); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; }
.card summary { padding: 6px 10px; cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; }
.card summary::-webkit-details-marker { display: none; }
.card summary::before { content: '▸'; color: var(--muted); font-size: 10px; transition: transform .1s; }
.card[open] summary::before { transform: rotate(90deg); }
.card .title { font-weight: 600; }
.card .budget { margin-left: auto; color: var(--muted); white-space: nowrap; }
.card .meter { height: 3px; background: var(--border); margin: 0 10px 6px; border-radius: 2px; overflow: hidden; }
.card .meter span { display: block; height: 100%; background: var(--vscode-progressBar-background); }
.card .rows { padding: 0 6px 6px; }
.ctx-row { padding: 4px 4px; border-radius: 4px; }
.ctx-row:hover { background: var(--vscode-list-hoverBackground); }
.ctx-top { display: flex; gap: 6px; align-items: baseline; }
.ctx-rank { color: var(--muted); font-size: 10px; width: 14px; text-align: right; flex: none; }
.ctx-file { min-width: 0; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-tokens { margin-left: auto; color: var(--muted); white-space: nowrap; font-size: 11px; }
.ctx-reason { color: var(--muted); font-size: 11px; margin-left: 20px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

#log { display: flex; flex-direction: column; gap: 6px; }
.msg { line-height: 1.5; font-size: 13px; word-break: break-word; }
.msg-text p { margin: 0 0 6px; } .msg-text p:last-child { margin-bottom: 0; }
.msg-text ul, .msg-text ol { margin: 4px 0; padding-left: 20px; }
.msg pre { background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; overflow-x: auto; font-size: 11.5px; }
.msg code { font-family: var(--vscode-editor-font-family); font-size: 11.5px; }
.msg table { border-collapse: collapse; font-size: 12px; } .msg th, .msg td { border: 1px solid var(--border); padding: 2px 8px; }
.msg-user { align-self: flex-end; max-width: 92%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 10px 10px 2px 10px; padding: 6px 10px; white-space: pre-wrap; margin-top: 6px; }
.msg-tool { display: flex; gap: 6px; align-items: baseline; font-size: 11.5px; color: var(--muted); padding: 1px 2px; }
.msg-tool .name { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
.msg-tool .detail { min-width: 0; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-approval { border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500); background: var(--vscode-inputValidation-warningBackground, transparent); border-radius: var(--radius); padding: 6px 8px; font-size: 12px; }
.msg-review { font-size: 12px; padding: 2px; }
.msg-review.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.msg-review.none { color: var(--muted); }
.msg-notice { font-size: 12px; border-left: 3px solid var(--muted); padding: 3px 8px; color: var(--muted); }
.msg-notice.warn { border-color: var(--vscode-editorWarning-foreground); color: var(--vscode-foreground); }
.msg-notice.error { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
.msg-status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; margin: 4px 0 2px; }
.msg-status::before, .msg-status::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
.msg-status.error { color: var(--vscode-errorForeground); }

#working { display: none; align-items: center; gap: 8px; padding: 4px 12px; font-size: 11px; color: var(--muted); }
#working.show { display: flex; }
.spinner { width: 10px; height: 10px; border: 2px solid var(--border); border-top-color: var(--vscode-progressBar-background); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

#composer { position: relative; padding: 6px 12px 10px; border-top: 1px solid var(--border); }
#prompt { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: var(--radius); padding: 7px 9px; font-family: inherit; font-size: 13px; resize: none; min-height: 58px; max-height: 200px; }
#prompt:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#prompt:disabled { opacity: .6; }
.bar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.hint { min-width: 0; color: var(--muted); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-btn { background: none; border: none; color: var(--vscode-textLink-foreground); padding: 2px 4px; }
.link-btn:hover:not(:disabled) { text-decoration: underline; }
#send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 14px; }
#send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
#send.stop { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#complete { display: none; position: absolute; left: 12px; right: 12px; bottom: 100%; background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorSuggestWidget-border, var(--border)); border-radius: 4px; max-height: 180px; overflow-y: auto; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
#complete div { padding: 3px 8px; cursor: pointer; font-size: 12px; font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#complete div.active, #complete div:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

#overlay { display: none; position: absolute; inset: 0; background: var(--vscode-sideBar-background); padding: 10px 12px; overflow-y: auto; z-index: 5; }
#overlay.open { display: block; }
#overlay .hist-item { padding: 6px 8px; cursor: pointer; border-bottom: 1px solid var(--border); font-size: 12px; }
#overlay .hist-item:hover { background: var(--vscode-list-hoverBackground); }
#overlay .hist-when { color: var(--muted); font-size: 11px; }
#overlay .hist-log { display: flex; flex-direction: column; gap: 6px; }
`;
