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

/**
 * Drives the inline loader: the notification message and the in-editor
 * label show the current stage, the model's latest visible activity and
 * elapsed time (models often think silently for a while before streaming).
 */
export class LiveStatus {
  private label = 'Thinking…';
  private readonly started = Date.now();
  private lastRender = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly progress: vscode.Progress<{ message?: string }>,
    private readonly marker: PendingMarker,
  ) {
    this.render();
    this.timer = setInterval(() => this.render(), 1000);
  }

  /** New stage or model activity; renders at most ~5x per second. */
  update(label: string): void {
    this.label = label;
    if (Date.now() - this.lastRender > 200) {
      this.render();
    }
  }

  /** Hand over to the review: stop the clock, keep one instruction. */
  pause(message: string): void {
    this.stop();
    this.progress.report({ message });
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private render(): void {
    if (this.stopped) {
      return;
    }
    this.lastRender = Date.now();
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    this.progress.report({ message: `${this.label}  ·  ${seconds}s` });
    const short = this.label.length > 70 ? `${this.label.slice(0, 69)}…` : this.label;
    this.marker.set(`${short}  ${seconds}s`);
  }
}
