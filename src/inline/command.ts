import * as vscode from 'vscode';
import type { Host } from '../host';
import { collectDiagnostics } from '../host';
import { loadAgentFile } from '../trueforge/agents';
import type { CodeIndex } from '../context/index';
import { readText } from '../edits/proposals';
import { runInlineEdit, type InlineTarget } from './controller';
import { LiveStatus, PendingMarker } from './marker';
import { resolveTargetLines } from './target';
import { formatUsage } from '../flows/usage';
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
  // A selection ending at column 0 of the next line ends on the line above.
  const lastLine = !sel.isEmpty && sel.end.character === 0 && sel.end.line > sel.start.line
    ? sel.end.line
    : sel.end.line + 1;
  const lineText = doc.lineAt(sel.start.line).text;
  const lines = resolveTargetLines(
    {
      startLine: sel.start.line + 1,
      endLine: lastLine,
      empty: sel.isEmpty,
      partial: sel.start.line === sel.end.line && doc.getText(sel).trim() !== lineText.trim(),
    },
    index.chunks.filter((c) => c.path === relPath),
  );
  if (!lines) {
    return undefined;
  }
  const { startLine, endLine } = lines;
  const range = new vscode.Range(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length);
  const selectedText = doc.getText(range);
  if (lines.expandedTo) {
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
  const agent = loadAgentFile(host.agentsDir, 'forgepilot-inline.yaml', host.config.primaryModel);
  const spec = agent.manifest;
  const marker = new PendingMarker(
    editor,
    new vscode.Range(target.startLine - 1, 0, target.endLine - 1, 0),
  );
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ForgePilot · ${where}`, cancellable: true },
    (progress, token) => inlineRun(progress, token, target, instruction),
  );

  async function inlineRun(
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
    target: InlineTarget,
    instruction: string,
  ): Promise<void> {
    const status = new LiveStatus(progress, marker);
    let tokens = '';
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
        agentName: agent.name,
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
        onUsage: (usage) => {
          tokens = formatUsage(usage);
          status.usage(tokens);
        },
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
    const spent = tokens ? `  ·  ${tokens} tokens` : '';
    const result: Record<string, string> = {
      applied: `✓ Edit applied to ${where}.${spent}`,
      rejected: `All hunks rejected; the file is unchanged.${spent}`,
      cancelled: `Cancelled; the file is unchanged.${spent}`,
    };
    const message = result[outcome];
    if (!message) {
      return;
    }
    // The loader closes here; the result gets real Undo / Close buttons.
    const buttons = outcome === 'applied' ? ['Undo', 'Close'] : ['Close'];
    void vscode.window.showInformationMessage(`ForgePilot: ${message}`, ...buttons).then((choice) => {
      if (choice === 'Undo') {
        void vscode.commands.executeCommand('forgePilot.undoLast');
      }
    });
  }
}
