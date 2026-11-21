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

  /**
   * Argument-free command per lens button. VS Code keeps a lens's
   * arguments in a cache that it drops whenever lenses are re-provided
   * (after every decision), so a quick click on a still-visible button
   * failed with "Actual command not found". Ids are keyed by review.
   */
  private readonly lensCommands = new Map<string, Map<string, { id: string; disposable: vscode.Disposable }>>();
  private lensCounter = 0;

  constructor(private readonly getReviews: () => OpenReview[]) {}

  private lensCommand(reviewKey: string, command: string, args: unknown[]): string {
    let byReview = this.lensCommands.get(reviewKey);
    if (!byReview) {
      byReview = new Map();
      this.lensCommands.set(reviewKey, byReview);
    }
    const target = `${command} ${JSON.stringify(args)}`;
    let entry = byReview.get(target);
    if (!entry) {
      this.lensCounter += 1;
      const id = `forgePilot.lens.${this.lensCounter}`;
      entry = { id, disposable: vscode.commands.registerCommand(id, () => vscode.commands.executeCommand(command, ...args)) };
      byReview.set(target, entry);
    }
    return entry.id;
  }

  /** Drop a closed review's lens commands, after any in-flight clicks. */
  releaseLenses(runId: string, proposalId: string): void {
    const key = `${runId}:${proposalId}`;
    const byReview = this.lensCommands.get(key);
    this.lensCommands.delete(key);
    if (byReview) {
      setTimeout(() => byReview.forEach((entry) => entry.disposable.dispose()), 10_000);
    }
  }

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
            command: this.lensCommand(`${review.runId}:${review.proposalId}`, lens.command, lens.args),
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
