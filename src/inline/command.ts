import * as vscode from 'vscode';
import type { Host } from '../host';
import { collectDiagnostics } from '../host';
import { loadAgentFile } from '../trueforge/agents';
import type { CodeIndex } from '../context/index';
import { readText } from '../edits/proposals';
import { runInlineEdit, type InlineTarget } from './controller';
import { LiveStatus, PendingMarker } from './marker';
import { noticeLevel } from '../panel/present';

function showNotice(message: string): void {
  const level = noticeLevel(message);
  const text = `ForgePilot: ${message}`;
  if (level === 'error') {
    void vscode.window.showErrorMessage(text);
  } else if (level === 'warn') {
    void vscode.window.showWarningMessage(text);
  } else {
    void vscode.window.showInformationMessage(text);
  }
}

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
  const where = `${target.relPath}:${target.startLine}-${target.endLine}`;
  const instruction = await vscode.window.showInputBox({
    title: `ForgePilot: edit ${where}`,
    prompt: 'Describe the change. Only the selected lines are edited; you review every hunk before it is saved.',
    placeHolder: 'e.g. handle empty input and update the docstring',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }
  host.cancelled = false;
  const spec = loadAgentFile(host.agentsDir, 'forgepilot-inline.yaml', host.config.primaryModel).manifest;
  const marker = new PendingMarker(
    editor,
    new vscode.Range(target.startLine - 1, 0, target.endLine - 1, 0),
  );
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ForgePilot · ${where}`, cancellable: true },
    async (progress, token) => {
      const status = new LiveStatus(progress, marker);
      status.update(`Thinking with ${host.config.primaryModel}…`);
      // Hand the editor over to the diff colors once a proposal arrives.
      const review = {
        open: (rootDir: string, runId: string, proposalId: string, newText: string) => {
          status.pause('Review the hunks in the editor (Accept / Reject above each change).');
          marker.dispose();
          return host.review.open(rootDir, runId, proposalId, newText);
        },
      };
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
          review,
          proposeDeps: host.proposeDeps,
          readFullText: () => readText(host.rootDir, target.relPath),
          diagnostics: (rel) => collectDiagnostics(rel),
          onNotice: (message) => {
            status.update(noticeLevel(message) === 'warn' ? 'Primary model failed; trying the fallback model…' : message);
            showNotice(message);
          },
          onActivity: (text) => status.update(text),
          onSession: (sessionId) => {
            host.activeSession = sessionId;
          },
          onReviewComplete: (runId) => {
            host.lastRunId = runId;
          },
          isCancelled: () => host.cancelled,
        });
      } catch (err) {
        status.stop();
        marker.dispose();
        host.activeSession = undefined;
        void vscode.window.showErrorMessage(
          `ForgePilot inline edit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      status.stop();
      marker.dispose();
      host.activeSession = undefined;
      if (outcome === 'applied') {
        void vscode.window
          .showInformationMessage(`ForgePilot: edit applied to ${where}.`, 'Undo')
          .then((choice) => {
            if (choice === 'Undo') {
              void vscode.commands.executeCommand('forgePilot.undoLast');
            }
          });
      } else if (outcome === 'rejected') {
        void vscode.window.showInformationMessage('ForgePilot: all hunks rejected; the file is unchanged.');
      } else if (outcome === 'cancelled') {
        void vscode.window.showInformationMessage('ForgePilot: cancelled; the file is unchanged.');
      }
    },
  );
}
