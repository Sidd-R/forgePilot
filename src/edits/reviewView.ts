import * as vscode from 'vscode';
import type { Hunk } from '../types';

export interface ReviewResult {
  accepted: string[];
  rejected: string[];
}

export interface OpenReview {
  runId: string;
  proposalId: string;
  uri: vscode.Uri;
  beforeText: string;
  hunks: Hunk[];
  accepted: Set<string>;
  rejected: Set<string>;
  decided: Set<string>;
  resolve: (result: ReviewResult) => void;
}

export function appliedOf(review: OpenReview): Set<string> {
  return new Set(
    review.hunks.map((h) => h.id).filter((id) => !review.rejected.has(id)),
  );
}

/**
 * Buffer-space start line (1-based) per hunk id, given the set of hunks
 * currently applied in the buffer. Unapplied hunks keep original lines.
 */
export function mapHunkLines(hunks: Hunk[], applied: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  let delta = 0;
  for (const hunk of hunks) {
    out.set(hunk.id, hunk.startLine + delta);
    if (applied.has(hunk.id)) {
      delta += hunk.newLines.length - hunk.oldLines.length;
    }
  }
  return out;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  py: 'python',
  ts: 'typescript',
  js: 'javascript',
  tsx: 'typescriptreact',
  jsx: 'javascriptreact',
  md: 'markdown',
  rst: 'restructuredtext',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
};

/** Minimal review surface used by turn flows; faked in headless tests. */
export interface ReviewPort {
  open(
    rootDir: string,
    runId: string,
    proposalId: string,
    newText: string,
  ): Promise<ReviewResult>;
}

export function languageFor(relPath: string): string {
  const ext = relPath.split('.').pop() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

/** Decorations and CodeLens for open reviews. Never writes. */
export class ReviewView implements vscode.CodeLensProvider {
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;

  private readonly addedType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    isWholeLine: true,
  });
  private readonly removedType = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });

  constructor(private readonly getReviews: () => OpenReview[]) {}

  fire(): void {
    this.lensChanged.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const review of this.getReviews()) {
      if (review.uri.toString() !== document.uri.toString()) {
        continue;
      }
      const starts = mapHunkLines(review.hunks, appliedOf(review));
      for (const hunk of review.hunks) {
        if (review.decided.has(hunk.id)) {
          continue;
        }
        const line = (starts.get(hunk.id) ?? 1) - 1;
        const range = new vscode.Range(line, 0, line, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `✓ Accept ${hunk.id}`,
            command: 'forgePilot.acceptHunk',
            arguments: [review.runId, review.proposalId, hunk.id],
          }),
          new vscode.CodeLens(range, {
            title: `✗ Reject ${hunk.id}`,
            command: 'forgePilot.rejectHunk',
            arguments: [review.runId, review.proposalId, hunk.id],
          }),
        );
      }
    }
    return lenses;
  }

  refresh(editor: vscode.TextEditor): void {
    const review = this.getReviews().find(
      (candidate) => candidate.uri.toString() === editor.document.uri.toString(),
    );
    if (!review) {
      editor.setDecorations(this.addedType, []);
      editor.setDecorations(this.removedType, []);
      return;
    }
    const starts = mapHunkLines(review.hunks, appliedOf(review));
    const added: vscode.Range[] = [];
    const removed: vscode.DecorationOptions[] = [];
    for (const hunk of review.hunks) {
      if (review.decided.has(hunk.id)) {
        continue;
      }
      const start = (starts.get(hunk.id) ?? 1) - 1;
      if (hunk.newLines.length > 0) {
        added.push(new vscode.Range(start, 0, start + hunk.newLines.length - 1, 1_000_000));
      }
      if (hunk.oldLines.length > 0) {
        // `before` content renders inline, so multi-line removed text
        // would collapse onto the added line. Show a one-line chip and
        // keep the full text in the hover, which renders markdown.
        const count = hunk.oldLines.length;
        removed.push({
          range: new vscode.Range(start, 0, start, 0),
          hoverMessage: `Removed:\n\`\`\`\n${hunk.oldLines.join('\n')}\n\`\`\``,
          renderOptions: {
            before: {
              contentText: `− ${count} line${count === 1 ? '' : 's'} removed `,
              backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
            },
          },
        });
      }
    }
    editor.setDecorations(this.addedType, added);
    editor.setDecorations(this.removedType, removed);
    this.lensChanged.fire();
  }
}
