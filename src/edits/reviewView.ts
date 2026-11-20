import * as vscode from 'vscode';
import type { Hunk } from '../types';
import { layoutReview, planDecorations, planLenses, type ReviewLayout } from './reviewPlan';

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

/** Current buffer layout of a review: text plus undecided hunk spans. */
export function layoutOf(review: OpenReview): ReviewLayout {
  return layoutReview(review.beforeText, review.hunks, review.decided, review.accepted);
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
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    isWholeLine: true,
    opacity: '0.75',
    textDecoration: 'line-through',
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
      for (const lens of planLenses(
        review.runId,
        review.proposalId,
        review.hunks,
        layoutOf(review).spans,
      )) {
        const range = new vscode.Range(lens.line - 1, 0, lens.line - 1, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: lens.title,
            command: lens.command,
            arguments: lens.args,
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
    const plan = planDecorations(layoutOf(review).spans);
    const toRange = (span: { startLine: number; endLine: number }): vscode.Range =>
      new vscode.Range(span.startLine - 1, 0, span.endLine - 1, 1_000_000);
    const added = plan.added.map(toRange);
    const removed = plan.removed.map(toRange);
    editor.setDecorations(this.addedType, added);
    editor.setDecorations(this.removedType, removed);
    this.lensChanged.fire();
  }
}
