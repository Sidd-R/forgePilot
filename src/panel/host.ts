import * as vscode from 'vscode';
import type { TranscriptEvent } from '../types';
import { loadAgentFile } from '../trueforge/agents';
import { buildPack } from '../context/pack';
import { runAgentTurn } from '../flows/agent';
import { packSummary, parseMentions, renderPack } from './prompt';
import {
  askCommand,
  errorText,
  mentionItems,
  openWorkspaceFile,
  type PanelActions,
  type PanelInbound,
} from './requests';
import { panelHtml } from './view';
import { ChatHistory, type ChatStorage } from './history';
import { sessionUrl } from './present';
import { addUsage, formatUsage, ZERO_USAGE, type TokenUsage } from '../flows/usage';
import { setBusy, type Host } from '../host';

/** Agent panel: prompt box, context card, streamed transcript, run controls. */
export class PanelHost implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private sessionId: string | undefined;
  private running = false;
  private startedAt = 0;
  private model = '';
  private runUsage: TokenUsage = ZERO_USAGE;
  private chatUsage: TokenUsage = ZERO_USAGE;
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

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = panelHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((message: PanelInbound) => {
      void this.onMessage(message).catch((err: unknown) => this.notify(errorText(err)));
    });
    // Rehydrate after reloads or disposal: retained views never reach here.
    const live = this.history.liveEvents();
    if (live.length > 0) {
      this.post('transcriptBatch', { events: live });
    }
    this.postRunState();
    this.refreshMeta();
  }

  /** Model, session link and undo availability for the header. */
  refreshMeta(): void {
    this.post('meta', {
      model: this.model || this.host.config.primaryModel,
      fallbacks: this.host.config.fallbackModels,
      sessionUrl: this.sessionId ? sessionUrl(this.host.config.baseUrl, this.sessionId) : '',
      canUndo: this.host.lastRunId !== undefined,
    });
    this.postUsage();
  }

  private postUsage(): void {
    const chat = addUsage(this.chatUsage, this.running ? this.runUsage : ZERO_USAGE);
    this.post('usage', {
      run: this.runUsage.calls > 0 ? formatUsage(this.runUsage) : '',
      chat: chat.calls > 0 ? formatUsage(chat) : '',
      calls: chat.calls,
    });
  }

  newChat(): void {
    if (this.running) {
      this.notify('Cancel the current run before starting a new chat.');
      return;
    }
    this.history.finalize();
    this.sessionId = undefined;
    this.model = '';
    this.runUsage = ZERO_USAGE;
    this.chatUsage = ZERO_USAGE;
    this.post('cleared');
    this.refreshMeta();
  }

  showHistory(): void {
    this.post('historyList', { items: this.history.list() });
  }

  notifyUndo(scope: 'last' | 'run', files: string): void {
    this.notify(`${scope === 'last' ? 'Undid last change' : 'Undid run'}: ${files}`);
    this.refreshMeta();
  }

  private post(type: string, payload: Record<string, unknown> = {}): void {
    void this.view?.webview.postMessage({ type, ...payload });
  }

  private postRunState(): void {
    this.post('runState', { running: this.running, startedAt: this.startedAt });
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
        this.newChat();
        break;
      case 'historyList':
        this.showHistory();
        break;
      case 'historyOpen':
        if (message.chatId) {
          this.post('historyOpened', { events: this.history.open(message.chatId) });
        }
        break;
      case 'openFile':
        if (message.path) {
          await openWorkspaceFile(this.host.rootDir, message.path, message.line ?? 1);
        }
        break;
      case 'openSession':
        await vscode.commands.executeCommand('forgePilot.openSession');
        break;
      case 'mentionQuery':
        this.post('mentionResults', {
          id: message.id ?? 0,
          items: mentionItems(this.host.index, message.kind ?? 'file', message.query ?? ''),
        });
        break;
    }
  }

  private async runPrompt(prompt: string): Promise<void> {
    if (this.running || !prompt.trim()) {
      return;
    }
    if (this.host.busy) {
      this.notify('An inline edit is in progress. Finish or cancel it first.');
      return;
    }
    if (!this.host.config.primaryModel) {
      this.notify('No model configured: set forgepilot.models.primary in Settings.');
      return;
    }
    this.running = true;
    setBusy(this.host, true);
    this.host.cancelled = false;
    this.startedAt = Date.now();
    this.runUsage = ZERO_USAGE;
    this.postRunState();
    this.history.beginPrompt(prompt);
    this.pushTranscript({ kind: 'user', text: prompt });
    this.flush();
    this.flushTimer = setInterval(() => this.flush(), 50);
    try {
      const { files, symbols, clean } = parseMentions(this.host.index, prompt);
      const pack = buildPack(this.host.index, clean, {
        budget: this.host.config.tokenBudget,
        mentionedFiles: files,
        mentionedSymbols: symbols,
      });
      // Inline so saved chats keep which files were chosen and why.
      this.pushTranscript({ kind: 'context', text: packSummary(pack) });
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
        askCommand,
        onTranscript: (event) => this.pushTranscript(event),
        onNotice: (text) => this.notify(text),
        onSession: (sessionId) => {
          this.sessionId = sessionId;
          this.host.activeSession = sessionId;
          this.refreshMeta();
        },
        onReviewComplete: (runId, proposalId, accepted, rejected) => {
          this.host.lastRunId = runId;
          const path = this.host.store.getProposal(runId, proposalId)?.path ?? proposalId;
          this.pushTranscript({
            kind: 'review',
            text: `${path}: ${accepted} accepted, ${rejected} rejected`,
          });
          this.refreshMeta();
        },
        onUsage: (usage) => {
          this.runUsage = usage;
          this.postUsage();
        },
        isCancelled: () => this.host.cancelled,
        sessionId: this.sessionId,
      });
      if (result.model) {
        this.model = result.model;
      }
      if (result.status === 'error') {
        // Next prompt starts a fresh session with the full fallback chain.
        this.sessionId = undefined;
      } else if (result.sessionId) {
        this.sessionId = result.sessionId;
      }
      this.pushTranscript({ kind: 'status', text: result.status });
    } catch (err) {
      this.pushTranscript({ kind: 'notice', text: errorText(err) });
      this.pushTranscript({ kind: 'status', text: 'error' });
    } finally {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
      this.flush();
      this.chatUsage = addUsage(this.chatUsage, this.runUsage);
      this.running = false;
      setBusy(this.host, false);
      this.host.activeSession = undefined;
      this.postRunState();
      this.refreshMeta();
    }
  }
}
