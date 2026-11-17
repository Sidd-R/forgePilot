import * as vscode from 'vscode';
import { buildHost, collectDiagnostics, type Host } from './host';
import { loadAgentFile, syncAgent } from './trueforge/agents';
import { CodeIndex } from './context/index';
import { applyRestores, readText } from './edits/proposals';
import { runInlineEdit, type InlineTarget } from './inline/controller';

let host: Host | undefined;

function captureTarget(editor: vscode.TextEditor, index: CodeIndex): InlineTarget | undefined {
  const doc = editor.document;
  const relPath = vscode.workspace.asRelativePath(doc.uri);
  const sel = editor.selection;
  let startLine: number;
  let endLine: number;
  let selectedText: string;
  if (!sel.isEmpty) {
    startLine = sel.start.line + 1;
    endLine = sel.end.line + 1;
    selectedText = doc.getText(sel);
  } else {
    const line = sel.active.line + 1;
    const chunk = index.chunks.find(
      (c) => c.path === relPath && c.startLine <= line && line <= c.endLine && c.symbol,
    );
    if (!chunk) {
      return undefined;
    }
    startLine = chunk.startLine;
    endLine = chunk.endLine;
    const range = new vscode.Range(
      startLine - 1,
      0,
      endLine - 1,
      doc.lineAt(endLine - 1).text.length,
    );
    selectedText = doc.getText(range);
    editor.selection = new vscode.Selection(range.start, range.end);
  }
  const beforeStart = Math.max(0, startLine - 1 - 40);
  const afterEnd = Math.min(doc.lineCount, endLine + 40);
  return {
    rootDir: vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? '',
    relPath,
    startLine,
    endLine,
    selectedText,
    beforeText: doc.getText(new vscode.Range(beforeStart, 0, startLine - 1, 0)),
    afterText: doc.getText(
      new vscode.Range(
        endLine - 1,
        doc.lineAt(endLine - 1).text.length,
        Math.max(endLine - 1, afterEnd - 1),
        doc.lineAt(Math.max(endLine - 1, afterEnd - 1)).text.length,
      ),
    ),
  };
}

async function runInlineCommand(): Promise<void> {
  if (!host) {
    return;
  }
  const h = host;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('ForgePilot: open a file first.');
    return;
  }
  const target = captureTarget(editor, h.index);
  if (!target || !target.selectedText.trim()) {
    void vscode.window.showWarningMessage('ForgePilot: select code or place the cursor in a function.');
    return;
  }
  if (!h.config.primaryModel) {
    void vscode.window.showErrorMessage('ForgePilot: set forgepilot.models.primary first.');
    return;
  }
  const instruction = await vscode.window.showInputBox({
    title: 'ForgePilot Inline Edit',
    prompt: 'Describe the edit',
  });
  if (!instruction) {
    return;
  }
  h.cancelled = false;
  const spec = loadAgentFile(h.agentsDir, 'forgepilot-inline.yaml', h.config.primaryModel).manifest;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ForgePilot inline edit', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        h.cancelled = true;
        if (h.activeSession) {
          void h.client.cancel(h.activeSession).catch(() => undefined);
        }
      });
      const outcome = await runInlineEdit({
        client: h.client,
        spec,
        models: [h.config.primaryModel, ...h.config.fallbackModels],
        target,
        instruction,
        store: h.store,
        review: h.review,
        proposeDeps: h.proposeDeps,
        readFullText: () => readText(h.rootDir, target.relPath),
        diagnostics: (rel) => collectDiagnostics(rel),
        onNotice: (message) => void vscode.window.showInformationMessage(`ForgePilot: ${message}`),
        onSession: (sessionId) => {
          h.activeSession = sessionId;
        },
        onReviewComplete: (runId) => {
          h.lastRunId = runId;
        },
        isCancelled: () => h.cancelled,
      });
      h.activeSession = undefined;
      if (outcome === 'applied') {
        void vscode.window.showInformationMessage('ForgePilot: edit applied.');
      } else if (outcome === 'cancelled') {
        void vscode.window.showInformationMessage('ForgePilot: cancelled.');
      }
    },
  );
}

async function cancelActive(): Promise<void> {
  if (!host?.activeSession) {
    return;
  }
  host.cancelled = true;
  const sessionId = host.activeSession;
  host.activeSession = undefined;
  await host.client.cancel(sessionId).catch(() => undefined);
  host.runner.kill();
  await host.review.closeAllAsRejectAll(host.rootDir);
  void vscode.window.showInformationMessage('ForgePilot: run cancelled.');
}

async function undoLast(): Promise<void> {
  if (!host?.lastRunId) {
    return;
  }
  await applyRestores(host.rootDir, host.store.undoLast(host.lastRunId));
  void vscode.window.showInformationMessage('ForgePilot: undone last change.');
}

async function undoRun(): Promise<void> {
  if (!host?.lastRunId) {
    return;
  }
  await applyRestores(host.rootDir, host.store.undoRun(host.lastRunId));
  void vscode.window.showInformationMessage('ForgePilot: undone run.');
}

async function loadAgents(): Promise<void> {
  if (!host) {
    return;
  }
  if (!host.config.primaryModel) {
    void vscode.window.showErrorMessage('ForgePilot: set forgepilot.models.primary first.');
    return;
  }
  for (const file of ['forgepilot-coder.yaml', 'forgepilot-inline.yaml']) {
    const agent = loadAgentFile(host.agentsDir, file, host.config.primaryModel);
    await syncAgent(host.config.baseUrl, agent);
  }
  void vscode.window.showInformationMessage('ForgePilot: agent definitions synced.');
}

export function activate(context: vscode.ExtensionContext): void {
  void buildHost(context.extensionUri).then(
    (h) => {
      host = h;
      context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, h.review.view),
        vscode.workspace.onDidCloseTextDocument((doc) => {
          const found = h.review.reviewForUri(doc.uri);
          if (found) {
            void h.review.closeAsRejectAll(h.rootDir, found.runId, found.proposalId);
          }
        }),
        vscode.workspace.onDidSaveTextDocument(() => {
          const fresh = CodeIndex.build(h.rootDir);
          h.index = fresh;
          h.indexBox.index = fresh;
          void fresh.loadCochange(h.rootDir);
        }),
        vscode.commands.registerCommand('forgePilot.inlineEdit', runInlineCommand),
        vscode.commands.registerCommand('forgePilot.openAgent', () => {
          void vscode.window.showInformationMessage('ForgePilot: agent panel lands with the panel track.');
        }),
        vscode.commands.registerCommand('forgePilot.cancel', cancelActive),
        vscode.commands.registerCommand(
          'forgePilot.acceptHunk',
          (runId: string, proposalId: string, hunkId: string) => {
            void h.review.decideHunk(h.rootDir, runId, proposalId, hunkId, 'accepted');
          },
        ),
        vscode.commands.registerCommand(
          'forgePilot.rejectHunk',
          (runId: string, proposalId: string, hunkId: string) => {
            void h.review.decideHunk(h.rootDir, runId, proposalId, hunkId, 'rejected');
          },
        ),
        vscode.commands.registerCommand('forgePilot.acceptAll', () => {
          const uri = vscode.window.activeTextEditor?.document.uri;
          const found = uri ? h.review.reviewForUri(uri) : undefined;
          if (found) {
            void h.review.decideAll(h.rootDir, found.runId, found.proposalId, 'accepted');
          }
        }),
        vscode.commands.registerCommand('forgePilot.rejectAll', () => {
          const uri = vscode.window.activeTextEditor?.document.uri;
          const found = uri ? h.review.reviewForUri(uri) : undefined;
          if (found) {
            void h.review.decideAll(h.rootDir, found.runId, found.proposalId, 'rejected');
          }
        }),
        vscode.commands.registerCommand('forgePilot.undoLast', undoLast),
        vscode.commands.registerCommand('forgePilot.undoRun', undoRun),
        vscode.commands.registerCommand('forgePilot.loadAgents', loadAgents),
      );
    },
    (err: unknown) => {
      void vscode.window.showErrorMessage(
        `ForgePilot activation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
}

export function deactivate(): void {
  void host?.mcp.close();
  host = undefined;
}
