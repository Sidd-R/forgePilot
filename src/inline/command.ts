import * as vscode from 'vscode';
import type { Host } from '../host';
import { collectDiagnostics } from '../host';
import { loadAgentFile } from '../trueforge/agents';
import type { CodeIndex } from '../context/index';
import { readText } from '../edits/proposals';
import { runInlineEdit, type InlineTarget } from './controller';

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

/** ForgePilot: Inline Edit command. */
export async function runInlineCommand(host: Host): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('ForgePilot: open a file first.');
    return;
  }
  const target = captureTarget(editor, host.index);
  if (!target || !target.selectedText.trim()) {
    void vscode.window.showWarningMessage('ForgePilot: select code or place the cursor in a function.');
    return;
  }
  if (!host.config.primaryModel) {
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
  host.cancelled = false;
  const spec = loadAgentFile(host.agentsDir, 'forgepilot-inline.yaml', host.config.primaryModel).manifest;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ForgePilot inline edit', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        host.cancelled = true;
        // Resolve any open review first: with the silence timer disarmed
        // while paused, a pending review would wedge the loader forever,
        // and its lenses and colors would haunt the editor.
        void host.review.closeAllAsRejectAll(host.rootDir);
        if (host.activeSession) {
          void host.client.cancel(host.activeSession).catch(() => undefined);
        }
      });
      let outcome: string;
      try {
        outcome = await runInlineEdit({
          client: host.client,
          spec,
          models: [host.config.primaryModel, ...host.config.fallbackModels],
          target,
          instruction,
          store: host.store,
          review: host.review,
          proposeDeps: host.proposeDeps,
          readFullText: () => readText(host.rootDir, target.relPath),
          diagnostics: (rel) => collectDiagnostics(rel),
          onNotice: (message) => void vscode.window.showInformationMessage(`ForgePilot: ${message}`),
          onSession: (sessionId) => {
            host.activeSession = sessionId;
          },
          onReviewComplete: (runId) => {
            host.lastRunId = runId;
          },
          isCancelled: () => host.cancelled,
        });
      } catch (err) {
        host.activeSession = undefined;
        void vscode.window.showErrorMessage(
          `ForgePilot inline edit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      host.activeSession = undefined;
      if (outcome === 'applied') {
        void vscode.window.showInformationMessage('ForgePilot: edit applied.');
      } else if (outcome === 'cancelled') {
        void vscode.window.showInformationMessage('ForgePilot: cancelled.');
      }
    },
  );
}
