import * as vscode from 'vscode';
import { applyHunks } from './diff';
import { ProposalStore, applyText, readText, writeFile } from './proposals';
import { appliedOf, languageFor, mapHunkLines, ReviewView } from './reviewView';
import type { OpenReview, ReviewPort, ReviewResult } from './reviewView';

export type { ReviewResult, ReviewPort };

/**
 * In-editor hunk review. Stages the full proposal in the buffer unsaved
 * and recomputes it from the original plus unrejected hunks on every
 * decision. All writes go through proposals.ts; this module never writes.
 */
export class ReviewController implements ReviewPort {
  private reviews = new Map<string, OpenReview>();
  readonly view: ReviewView;

  constructor(private readonly store: ProposalStore) {
    this.view = new ReviewView(() => [...this.reviews.values()]);
  }

  /** Open review for a proposal staged by prepareProposal. */
  async open(
    rootDir: string,
    runId: string,
    proposalId: string,
    newText: string,
  ): Promise<ReviewResult> {
    const proposal = this.store.getProposal(runId, proposalId);
    const before = this.store.beforeText(runId, proposalId);
    if (!proposal || before === undefined) {
      throw new Error('Review opened for an unknown proposal.');
    }
    if (proposal.isNewFile || before === null) {
      return this.openNewFile(rootDir, runId, proposalId, newText);
    }
    const current = await readText(rootDir, proposal.path);
    if (current !== before) {
      throw new Error(`File ${proposal.path} changed since the proposal was built.`);
    }
    await applyText(rootDir, proposal.path, newText, false);
    const uri = vscode.Uri.joinPath(vscode.Uri.file(rootDir), proposal.path);
    const editor = await vscode.window.showTextDocument(uri);
    const key = this.key(runId, proposalId);
    const prevAutoSave = vscode.workspace.getConfiguration('files').get('autoSave');
    await vscode.workspace.getConfiguration('files').update('autoSave', 'off', true);

    return new Promise<ReviewResult>((resolve) => {
      const review: OpenReview = {
        runId,
        proposalId,
        uri,
        beforeText: before,
        hunks: proposal.hunks,
        accepted: new Set(),
        rejected: new Set(),
        decided: new Set(),
        resolve,
        prevAutoSave,
      };
      this.reviews.set(key, review);
      void vscode.commands.executeCommand('setContext', 'forgePilot.reviewActive', true);
      this.view.refresh(editor);
      const first = mapHunkLines(proposal.hunks, appliedOf(review)).get(
        proposal.hunks[0]?.id ?? '',
      );
      if (first !== undefined) {
        editor.revealRange(new vscode.Range(first - 1, 0, first - 1, 0));
      }
    });
  }

  /** New files get a read-only preview with a single accept/reject. */
  private async openNewFile(
    rootDir: string,
    runId: string,
    proposalId: string,
    newText: string,
  ): Promise<ReviewResult> {
    const proposal = this.store.getProposal(runId, proposalId);
    if (!proposal) {
      throw new Error('Review opened for an unknown proposal.');
    }
    const doc = await vscode.workspace.openTextDocument({
      content: newText,
      language: languageFor(proposal.path),
    });
    await vscode.window.showTextDocument(doc);
    const choice = await vscode.window.showInformationMessage(
      `Accept new file ${proposal.path}?`,
      'Accept',
      'Reject',
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    if (choice === 'Accept') {
      this.store.decide(runId, proposalId, 'h1', 'accepted');
      await writeFile(rootDir, proposal.path, newText);
      return { accepted: ['h1'], rejected: [] };
    }
    this.store.decide(runId, proposalId, 'h1', 'rejected');
    return { accepted: [], rejected: ['h1'] };
  }

  async decideHunk(
    rootDir: string,
    runId: string,
    proposalId: string,
    hunkId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<ReviewResult | undefined> {
    const review = this.reviews.get(this.key(runId, proposalId));
    if (!review || review.decided.has(hunkId)) {
      return undefined;
    }
    this.applyDecision(runId, proposalId, review, hunkId, decision);
    if (review.decided.size >= review.hunks.length) {
      return this.finish(rootDir, review);
    }
    await this.restage(rootDir, review);
    return undefined;
  }

  async decideAll(
    rootDir: string,
    runId: string,
    proposalId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<ReviewResult | undefined> {
    const review = this.reviews.get(this.key(runId, proposalId));
    if (!review) {
      return undefined;
    }
    for (const hunk of review.hunks) {
      if (!review.decided.has(hunk.id)) {
        this.applyDecision(runId, proposalId, review, hunk.id, decision);
      }
    }
    return this.finish(rootDir, review);
  }

  /** Cancel or editor-close: reject everything, restore the original text. */
  async closeAsRejectAll(rootDir: string, runId: string, proposalId: string): Promise<void> {
    const review = this.reviews.get(this.key(runId, proposalId));
    if (!review) {
      return;
    }
    for (const hunk of review.hunks) {
      this.applyDecision(runId, proposalId, review, hunk.id, 'rejected');
    }
    review.accepted.clear();
    await this.finish(rootDir, review);
  }

  /** Close every open review as Reject All (Cancel path). */
  async closeAllAsRejectAll(rootDir: string): Promise<void> {
    for (const review of [...this.reviews.values()]) {
      await this.closeAsRejectAll(rootDir, review.runId, review.proposalId);
    }
  }

  reviewForUri(uri: vscode.Uri): { runId: string; proposalId: string } | undefined {
    const review = [...this.reviews.values()].find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    return review ? { runId: review.runId, proposalId: review.proposalId } : undefined;
  }

  private applyDecision(
    runId: string,
    proposalId: string,
    review: OpenReview,
    hunkId: string,
    decision: 'accepted' | 'rejected',
  ): void {
    this.store.decide(runId, proposalId, hunkId, decision);
    review.decided.add(hunkId);
    if (decision === 'accepted') {
      review.accepted.add(hunkId);
    } else {
      review.rejected.add(hunkId);
    }
  }

  /** Restage the buffer: full proposal minus rejected hunks. */
  private async restage(rootDir: string, review: OpenReview): Promise<void> {
    const proposal = this.store.getProposal(review.runId, review.proposalId);
    if (!proposal) {
      return;
    }
    const text = applyHunks(review.beforeText, proposal.hunks, appliedOf(review));
    const rel = vscode.workspace.asRelativePath(review.uri);
    await applyText(rootDir, rel, text, false);
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === review.uri.toString(),
    );
    if (editor) {
      this.view.refresh(editor);
    }
  }

  private async finish(rootDir: string, review: OpenReview): Promise<ReviewResult> {
    const key = this.key(review.runId, review.proposalId);
    this.reviews.delete(key);
    const accepted = [...review.accepted];
    const rejected = review.hunks.map((h) => h.id).filter((id) => !review.accepted.has(id));
    const result = { accepted, rejected };
    try {
      const proposal = this.store.getProposal(review.runId, review.proposalId);
      if (proposal) {
        const text = applyHunks(review.beforeText, proposal.hunks, review.accepted);
        const rel = vscode.workspace.asRelativePath(review.uri);
        await applyText(rootDir, rel, text, accepted.length > 0);
      }
      await vscode.workspace.getConfiguration('files').update('autoSave', review.prevAutoSave, true);
      if (this.reviews.size === 0) {
        await vscode.commands.executeCommand('setContext', 'forgePilot.reviewActive', false);
      }
    } finally {
      // Always runs: the review is already out of the map, so refresh
      // clears its colors instead of repainting them, and the turn flow
      // never wedges on an unsettled review promise.
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === review.uri.toString(),
      );
      if (editor) {
        this.view.refresh(editor);
      } else {
        this.view.fire();
      }
      review.resolve(result);
    }
    return result;
  }

  private key(runId: string, proposalId: string): string {
    return `${runId}:${proposalId}`;
  }
}
