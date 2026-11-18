import * as vscode from 'vscode';
import type { TranscriptEvent } from '../types';
import { loadAgentFile } from '../trueforge/agents';
import { buildPack } from '../context/pack';
import { resolveFileMention, resolveSymbolMention } from '../context/mentions';
import { runAgentTurn } from '../flows/agent';
import { parseMentions, renderPack } from './prompt';
import { panelHtml } from './view';
import { ChatHistory, type ChatStorage } from './history';
import type { Host } from '../host';

/** Webview -> host messages. */
export interface PanelInbound {
  type:
    | 'prompt'
    | 'cancel'
    | 'undoLast'
    | 'undoRun'
    | 'newChat'
    | 'mentionQuery'
    | 'historyList'
    | 'historyOpen';
  text?: string;
  kind?: 'file' | 'symbol';
  query?: string;
  id?: number;
  chatId?: string;
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
  private readonly history: ChatHistory;

  constructor(
    private readonly host: Host,
    private readonly actions: PanelActions,
    private readonly extensionUri: vscode.Uri,
    storage: ChatStorage,
  ) {
    this.history = new ChatHistory(storage);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = panelHtml(view.webview, this.extensionUri);
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
    this.history.append(batch);
    this.post('transcriptBatch', { events: batch });
  }

  private pushTranscript(event: TranscriptEvent): void {
    this.queue.push(event);
  }

  /** Notices also land in the transcript so saved chats replay faithfully. */
  private notify(text: string): void {
    this.pushTranscript({ kind: 'notice', text });
    if (!this.running) {
      this.flush();
    }
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
        this.history.finalize();
        this.sessionId = undefined;
        this.post('cleared');
        break;
      case 'historyList':
        this.post('historyList', { items: this.history.list() });
        break;
      case 'historyOpen':
        if (message.chatId) {
          this.post('historyOpened', { events: this.history.open(message.chatId) });
        }
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
      this.notify('Set forgepilot.models.primary first.');
      return;
    }
    this.running = true;
    this.post('runState', { running: true });
    this.history.beginPrompt(prompt);
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
        onNotice: (text) => this.notify(text),
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
      this.pushTranscript({ kind: 'status', text: `Turn ${result.status}` });
    } finally {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
      this.flush();
      this.running = false;
      this.host.activeSession = undefined;
      this.post('runState', { running: false });
    }
  }
}
