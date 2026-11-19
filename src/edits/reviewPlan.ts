import type { Hunk } from '../types';

/**
 * Pure review-surface planner: which inline buttons and diff colors a
 * review should show. Lines are 1-based buffer lines. This module stays
 * free of `vscode` imports so headless tests can pin the rules;
 * reviewView.ts maps the plan onto editor objects.
 */

/** One inline button the review surface should show. */
export interface PlannedLens {
  line: number;
  title: string;
  command: string;
  args: string[];
}

/** Diff coloring the review surface should show. */
export interface PlannedDecorations {
  added: Array<{ startLine: number; endLine: number }>;
  removed: Array<{ line: number; text: string }>;
}

/** Per-hunk accept/reject buttons for every undecided hunk. */
export function planLenses(
  runId: string,
  proposalId: string,
  hunks: Hunk[],
  decided: ReadonlySet<string>,
  starts: Map<string, number>,
): PlannedLens[] {
  const lenses: PlannedLens[] = [];
  for (const hunk of hunks) {
    if (decided.has(hunk.id)) {
      continue;
    }
    const line = starts.get(hunk.id) ?? 1;
    lenses.push(
      {
        line,
        title: `✓ Accept ${hunk.id}`,
        command: 'forgePilot.acceptHunk',
        args: [runId, proposalId, hunk.id],
      },
      {
        line,
        title: `✗ Reject ${hunk.id}`,
        command: 'forgePilot.rejectHunk',
        args: [runId, proposalId, hunk.id],
      },
    );
  }
  return lenses;
}

/** Added/removed coloring for every undecided hunk; empty when decided. */
export function planDecorations(
  hunks: Hunk[],
  decided: ReadonlySet<string>,
  starts: Map<string, number>,
): PlannedDecorations {
  const added: PlannedDecorations['added'] = [];
  const removed: PlannedDecorations['removed'] = [];
  for (const hunk of hunks) {
    if (decided.has(hunk.id)) {
      continue;
    }
    const start = starts.get(hunk.id) ?? 1;
    if (hunk.newLines.length > 0) {
      added.push({ startLine: start, endLine: start + hunk.newLines.length - 1 });
    }
    if (hunk.oldLines.length > 0) {
      removed.push({ line: start, text: hunk.oldLines.join('\n') });
    }
  }
  return { added, removed };
}
