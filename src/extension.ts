import * as vscode from 'vscode';
import { buildHost, type Host } from './host';
import { loadAgentFile, syncAgent } from './trueforge/agents';
import { CodeIndex } from './context/index';
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
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, host.review.view),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        host.review.view.refresh(editor);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const found = host.review.reviewForUri(doc.uri);
      if (found) {
        void host.review.closeAsRejectAll(host.rootDir, found.runId, found.proposalId);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      const fresh = CodeIndex.build(host.rootDir);
      host.index = fresh;
      host.indexBox.index = fresh;
      void fresh.loadCochange(host.rootDir);
    }),
  );
}

async function inlineEdit(context: vscode.ExtensionContext): Promise<void> {
  await withHost(context, (host) => runInlineCommand(host));
}

async function cancelActive(context: vscode.ExtensionContext): Promise<void> {
  await withHost(context, async (host) => {
    if (!host.activeSession) {
      return;
    }
    host.cancelled = true;
    const sessionId = host.activeSession;
    host.activeSession = undefined;
    await host.client.cancel(sessionId).catch(() => undefined);
    host.runner.kill();
    await host.review.closeAllAsRejectAll(host.rootDir);
    void vscode.window.showInformationMessage('ForgePilot: run cancelled.');
  });
}

async function undoLast(context: vscode.ExtensionContext): Promise<void> {
  await withHost(context, async (host) => {
    if (!host.lastRunId) {
      return;
    }
    await applyRestores(host.rootDir, host.store.undoLast(host.lastRunId));
    void vscode.window.showInformationMessage('ForgePilot: undone last change.');
  });
}

async function undoRun(context: vscode.ExtensionContext): Promise<void> {
  await withHost(context, async (host) => {
    if (!host.lastRunId) {
      return;
    }
    await applyRestores(host.rootDir, host.store.undoRun(host.lastRunId));
    void vscode.window.showInformationMessage('ForgePilot: undone run.');
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
            undoLast: () => undoLast(context),
            undoRun: () => undoRun(context),
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
    vscode.commands.registerCommand('forgePilot.acceptAll', () => {
      void withHost(context, (host) => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        const found = uri ? host.review.reviewForUri(uri) : undefined;
        if (found) {
          return host.review.decideAll(host.rootDir, found.runId, found.proposalId, 'accepted');
        }
        return undefined;
      });
    }),
    vscode.commands.registerCommand('forgePilot.rejectAll', () => {
      void withHost(context, (host) => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        const found = uri ? host.review.reviewForUri(uri) : undefined;
        if (found) {
          return host.review.decideAll(host.rootDir, found.runId, found.proposalId, 'rejected');
        }
        return undefined;
      });
    }),
    vscode.commands.registerCommand('forgePilot.undoLast', () => undoLast(context)),
    vscode.commands.registerCommand('forgePilot.undoRun', () => undoRun(context)),
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
