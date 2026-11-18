import * as vscode from 'vscode';
import type { TranscriptEvent } from '../types';
import { loadAgentFile } from '../trueforge/agents';
import { buildPack } from '../context/pack';
import { resolveFileMention, resolveSymbolMention } from '../context/mentions';
import { runAgentTurn } from '../flows/agent';
import { parseMentions, renderPack } from './prompt';
import type { Host } from '../host';

/** Webview -> host messages. */
export interface PanelInbound {
  type: 'prompt' | 'cancel' | 'undoLast' | 'undoRun' | 'newChat' | 'mentionQuery';
  text?: string;
  kind?: 'file' | 'symbol';
  query?: string;
  id?: number;
}

export interface PanelActions {
  cancel: () => Promise<void>;
  undoLast: () => Promise<void>;
  undoRun: () => Promise<void>;
}

/** Agent panel: prompt box, context card, streamed transcript, run controls. */
export class PanelHost implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private sessionId: string | undefined;
  private running = false;
  private queue: TranscriptEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly host: Host,
    private readonly actions: PanelActions,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: PanelInbound) => {
      void this.onMessage(message);
    });
  }

  reveal(): void {
    void vscode.commands.executeCommand('forgePilot.panel.focus');
  }

  private post(type: string, payload: Record<string, unknown> = {}): void {
    void this.view?.webview.postMessage({ type, ...payload });
  }

  private flush(): void {
    if (this.queue.length === 0) {
      return;
    }
    const batch = this.queue;
    this.queue = [];
    this.post('transcriptBatch', { events: batch });
  }

  private pushTranscript(event: TranscriptEvent): void {
    this.queue.push(event);
  }

  private async onMessage(message: PanelInbound): Promise<void> {
    switch (message.type) {
      case 'prompt':
        await this.runPrompt(message.text ?? '');
        break;
      case 'cancel':
        await this.actions.cancel();
        break;
      case 'undoLast':
        await this.actions.undoLast();
        break;
      case 'undoRun':
        await this.actions.undoRun();
        break;
      case 'newChat':
        this.sessionId = undefined;
        this.post('cleared');
        break;
      case 'mentionQuery':
        this.post('mentionResults', {
          id: message.id ?? 0,
          items:
            message.kind === 'file'
              ? resolveFileMention(this.host.index, message.query ?? '')
              : resolveSymbolMention(this.host.index, message.query ?? '').map(
                  (hit) => `${hit.symbol} (${hit.path}:${hit.startLine})`,
                ),
        });
        break;
    }
  }

  private async runPrompt(prompt: string): Promise<void> {
    if (this.running || !prompt.trim()) {
      return;
    }
    if (!this.host.config.primaryModel) {
      this.post('notice', { text: 'Set forgepilot.models.primary first.' });
      return;
    }
    this.running = true;
    this.post('runState', { running: true });
    const { files, symbols, clean } = parseMentions(this.host.index, prompt);
    const pack = buildPack(this.host.index, clean, {
      budget: this.host.config.tokenBudget,
      mentionedFiles: files,
      mentionedSymbols: symbols,
    });
    this.post('contextCard', { pack });
    this.flushTimer = setInterval(() => this.flush(), 50);
    try {
      const spec = loadAgentFile(
        this.host.agentsDir,
        'forgepilot-coder.yaml',
        this.host.config.primaryModel,
      ).manifest;
      const result = await runAgentTurn({
        client: this.host.client,
        spec,
        models: [this.host.config.primaryModel, ...this.host.config.fallbackModels],
        input: renderPack(pack, clean),
        store: this.host.store,
        review: this.host.review,
        proposeDeps: this.host.proposeDeps,
        askCommand: async (command) => {
          const choice = await vscode.window.showInformationMessage(
            `Allow command? ${command}`,
            'Allow once',
            'Allow for this session',
            'Deny',
          );
          if (choice === 'Allow for this session') {
            return 'session';
          }
          return choice === 'Allow once' ? 'once' : 'deny';
        },
        onTranscript: (event) => this.pushTranscript(event),
        onNotice: (text) => this.post('notice', { text }),
        onSession: (sessionId) => {
          this.sessionId = sessionId;
          this.host.activeSession = sessionId;
        },
        isCancelled: () => this.host.cancelled,
        sessionId: this.sessionId,
      });
      if (result.sessionId) {
        this.sessionId = result.sessionId;
      }
      this.post('status', { text: `Turn ${result.status}` });
    } finally {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
      this.flush();
      this.running = false;
      this.host.activeSession = undefined;
      this.post('runState', { running: false });
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
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
<button id="undo1">Undo Last</button>
<button id="undoRun">Undo Run</button>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
}
