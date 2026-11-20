import * as vscode from 'vscode';

let pendingType: vscode.TextEditorDecorationType | undefined;

function decorationType(): vscode.TextEditorDecorationType {
  pendingType ??= vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findRangeHighlightBackground'),
    isWholeLine: true,
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
  });
  return pendingType;
}

/**
 * Highlights the range an inline edit targets, with a status label after
 * its first line, until the review takes over or the run ends.
 */
export class PendingMarker {
  private active = true;

  constructor(
    private readonly editor: vscode.TextEditor,
    private readonly range: vscode.Range,
  ) {}

  set(label: string): void {
    if (!this.active) {
      return;
    }
    const first = this.range.start.line;
    this.editor.setDecorations(decorationType(), [
      { range: new vscode.Range(first, 0, this.range.end.line, 0) },
      {
        range: new vscode.Range(first, Number.MAX_SAFE_INTEGER, first, Number.MAX_SAFE_INTEGER),
        renderOptions: {
          after: {
            contentText: `   ✦ ForgePilot: ${label}`,
            color: new vscode.ThemeColor('descriptionForeground'),
            fontStyle: 'italic',
          },
        },
      },
    ]);
  }

  dispose(): void {
    this.active = false;
    this.editor.setDecorations(decorationType(), []);
  }
}
