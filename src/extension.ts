import * as vscode from 'vscode';
import { buildHost, setBusy, type Host } from './host';
import { StatusIndicator } from './status';
import { editorListeners } from './listeners';
import { sessionUrl } from './panel/present';
import { loadAgentFile, syncAgent } from './trueforge/agents';
import { applyRestores } from './edits/proposals';
import { runInlineCommand } from './inline/command';
import { PanelHost } from './panel/host';

let hostPromise: Promise<Host> | undefined;
let extensionUri: vscode.Uri | undefined;
let listenersRegistered = false;
let panelHost: PanelHost | undefined;

function resetForTests(): void {
  hostPromise = undefined;
  listenersRegistered = false;
  panelHost = undefined;
}

/**
 * Lazily build the host on first use. Failures reject (showing a clear
 * message at the call site) without poisoning later attempts: fixing the
 * cause (open folder, start TrueForge) and retrying just works.
 */
function ensureHost(context: vscode.ExtensionContext): Promise<Host> {
  if (!hostPromise) {
    hostPromise = buildHost(extensionUri ?? context.extensionUri).catch((err: unknown) => {
      hostPromise = undefined;
      throw err;
    });
  }
  return hostPromise;
}

async function withHost<T>(
  context: vscode.ExtensionContext,
  fn: (host: Host) => Promise<T> | T,
): Promise<T | undefined> {
  try {
    const host = await ensureHost(context);
    registerListeners(context, host);
    return await fn(host);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `ForgePilot: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** Editor listeners need a host; registered once, on first success. */
function registerListeners(context: vscode.ExtensionContext, host: Host): void {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;
  const status = new StatusIndicator();
  host.onBusyChange = (busy) => status.set(busy);
  context.subscriptions.push(status, ...editorListeners(host, () => panelHost?.refreshMeta()));
}

async function inlineEdit(context: vscode.ExtensionContext): Promise<void> {
  await withHost(context, async (host) => {
    if (host.busy) {
      void vscode.window.showWarningMessage('ForgePilot: a run is already in progress. Cancel it first.');
      return;
    }
    setBusy(host, true);
    try {
      await runInlineCommand(host);
    } finally {
      setBusy(host, false);
    }
  });
}

/** Accept/Reject All: from a lens (ids given) or the editor title (active file). */
function decideAll(
  context: vscode.ExtensionContext,
  decision: 'accepted' | 'rejected',
  runId?: string,
  proposalId?: string,
): void {
  void withHost(context, (host) => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const found =
      typeof runId === 'string' && typeof proposalId === 'string'
        ? { runId, proposalId }
        : uri
          ? host.review.reviewForUri(uri)
          : undefined;
    if (!found) {
      void vscode.window.showInformationMessage('ForgePilot: no pending review in this editor.');
      return undefined;
    }
    return host.review.decideAll(host.rootDir, found.runId, found.proposalId, decision);
  });
}

function openSession(host: Host, sessionId: string | undefined): void {
  const target = sessionId ? sessionUrl(host.config.baseUrl, sessionId) : host.config.baseUrl;
  void vscode.env.openExternal(vscode.Uri.parse(target));
}

async function cancelActive(context: vscode.ExtensionContext): Promise<void> {
  await withHost(context, async (host) => {
    if (!host.busy && !host.activeSession) {
      void vscode.window.showInformationMessage('ForgePilot: nothing is running.');
      return;
    }
    // Mark cancelled first so a run still creating its session stops
    // before its first turn, then tear down whatever already exists.
    host.cancelled = true;
    const sessionId = host.activeSession;
    host.activeSession = undefined;
    host.runner.kill();
    await host.review.closeAllAsRejectAll(host.rootDir);
    if (sessionId) {
      await host.client.cancel(sessionId).catch(() => undefined);
    }
    void vscode.window.showInformationMessage('ForgePilot: run cancelled. No files were changed by unreviewed edits.');
  });
}

async function undo(context: vscode.ExtensionContext, scope: 'last' | 'run'): Promise<void> {
  await withHost(context, async (host) => {
    if (host.busy) {
      void vscode.window.showWarningMessage('ForgePilot: finish or cancel the current run before undoing.');
      return;
    }
    const restores = host.lastRunId
      ? scope === 'last'
        ? host.store.undoLast(host.lastRunId)
        : host.store.undoRun(host.lastRunId)
      : [];
    if (restores.length === 0) {
      void vscode.window.showInformationMessage('ForgePilot: nothing to undo.');
      return;
    }
    await applyRestores(host.rootDir, restores);
    const files = restores.map((restore) => restore.path).join(', ');
    void vscode.window.showInformationMessage(
      `ForgePilot: ${scope === 'last' ? 'undid last change' : 'undid run'} (${files}).`,
    );
    panelHost?.notifyUndo(scope, files);
  });
}

async function loadAgents(context: vscode.ExtensionContext): Promise<void> {
  await withHost(context, async (host) => {
    if (!host.config.primaryModel) {
      void vscode.window.showErrorMessage('ForgePilot: set forgepilot.models.primary first.');
      return;
    }
    for (const file of ['forgepilot-coder.yaml', 'forgepilot-inline.yaml']) {
      const agent = loadAgentFile(host.agentsDir, file, host.config.primaryModel);
      await syncAgent(host.config.baseUrl, agent);
    }
    void vscode.window.showInformationMessage('ForgePilot: agent definitions synced.');
  });
}

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  // Register everything synchronously so commands always exist, even when
  // the host cannot build yet (no folder open, TrueForge down). Each
  // handler resolves the host lazily and reports failures clearly.
  const panelProvider = {
    resolveWebviewView: (view: vscode.WebviewView): void => {
      void withHost(context, async (host) => {
        // One PanelHost for the extension lifetime: a fresh instance per
        // resolve would drop the unfinalized live chat and context card.
        panelHost ??= new PanelHost(
          host,
          {
            cancel: () => cancelActive(context),
            undoLast: () => undo(context, 'last'),
            undoRun: () => undo(context, 'run'),
          },
          context.extensionUri,
          {
            get: () => context.globalState.get('forgePilot.chats', []),
            set: (records) => {
              void context.globalState.update('forgePilot.chats', records);
            },
          },
        );
        panelHost.resolveWebviewView(view);
      });
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('forgePilot.panel', panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('forgePilot.inlineEdit', () => inlineEdit(context)),
    vscode.commands.registerCommand('forgePilot.openAgent', () => {
      void vscode.commands.executeCommand('forgePilot.panel.focus');
    }),
    vscode.commands.registerCommand('forgePilot.cancel', () => cancelActive(context)),
    vscode.commands.registerCommand(
      'forgePilot.acceptHunk',
      (runId: string, proposalId: string, hunkId: string) => {
        void withHost(context, (host) =>
          host.review.decideHunk(host.rootDir, runId, proposalId, hunkId, 'accepted'),
        );
      },
    ),
    vscode.commands.registerCommand(
      'forgePilot.rejectHunk',
      (runId: string, proposalId: string, hunkId: string) => {
        void withHost(context, (host) =>
          host.review.decideHunk(host.rootDir, runId, proposalId, hunkId, 'rejected'),
        );
      },
    ),
    vscode.commands.registerCommand('forgePilot.acceptAll', (runId?: string, proposalId?: string) =>
      decideAll(context, 'accepted', runId, proposalId),
    ),
    vscode.commands.registerCommand('forgePilot.rejectAll', (runId?: string, proposalId?: string) =>
      decideAll(context, 'rejected', runId, proposalId),
    ),
    vscode.commands.registerCommand('forgePilot.undoLast', () => undo(context, 'last')),
    vscode.commands.registerCommand('forgePilot.undoRun', () => undo(context, 'run')),
    vscode.commands.registerCommand('forgePilot.newChat', () => panelHost?.newChat()),
    vscode.commands.registerCommand('forgePilot.showHistory', () => panelHost?.showHistory()),
    vscode.commands.registerCommand('forgePilot.openSession', () => {
      void withHost(context, (host) => openSession(host, panelHost?.currentSessionId));
    }),
    vscode.commands.registerCommand('forgePilot.loadAgents', () => loadAgents(context)),
  );
}

export function deactivate(): void {
  if (hostPromise) {
    void hostPromise.then((host) => host.mcp.close()).catch(() => undefined);
  }
  resetForTests();
}

export const __test__ = { resetForTests };
