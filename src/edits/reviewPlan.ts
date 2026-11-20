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

/** Where one hunk sits in the review buffer (1-based lines). */
export interface HunkSpan {
  /** First buffer line of the hunk (removed lines first, then added). */
  start: number;
  /** Removed (old) lines still shown, in red, while undecided. */
  removed: number;
  /** Added (new) lines shown, in green, while undecided. */
  added: number;
}

export interface ReviewLayout {
  text: string;
  spans: Map<string, HunkSpan>;
}

/**
 * Review buffer: undecided hunks show their old lines followed by their
 * new lines (a unified diff in place), accepted hunks show new lines and
 * rejected hunks show old lines. Only undecided hunks get a span.
 */
export function layoutReview(
  beforeText: string,
  hunks: Hunk[],
  decided: ReadonlySet<string>,
  accepted: ReadonlySet<string>,
): ReviewLayout {
  const lines = beforeText.split('\n');
  const out: string[] = [];
  const spans = new Map<string, HunkSpan>();
  let cursor = 0;
  for (const hunk of [...hunks].sort((a, b) => a.startLine - b.startLine)) {
    while (cursor < hunk.startLine - 1 && cursor < lines.length) {
      out.push(lines[cursor++]);
    }
    if (!decided.has(hunk.id)) {
      spans.set(hunk.id, {
        start: out.length + 1,
        removed: hunk.oldLines.length,
        added: hunk.newLines.length,
      });
      out.push(...hunk.oldLines, ...hunk.newLines);
    } else {
      out.push(...(accepted.has(hunk.id) ? hunk.newLines : hunk.oldLines));
    }
    cursor += hunk.oldLines.length;
  }
  out.push(...lines.slice(cursor));
  return { text: out.join('\n'), spans };
}

/** Diff coloring the review surface should show. */
export interface PlannedDecorations {
  added: Array<{ startLine: number; endLine: number }>;
  removed: Array<{ startLine: number; endLine: number }>;
}

/** Per-hunk accept/reject buttons for every undecided hunk. */
export function planLenses(
  runId: string,
  proposalId: string,
  hunks: Hunk[],
  spans: Map<string, HunkSpan>,
): PlannedLens[] {
  const lenses: PlannedLens[] = [];
  const pending = hunks.filter((hunk) => spans.has(hunk.id));
  hunks.forEach((hunk, index) => {
    const span = spans.get(hunk.id);
    if (!span) {
      return;
    }
    const line = span.start;
    const size = `+${hunk.newLines.length} −${hunk.oldLines.length}`;
    lenses.push(
      {
        line,
        title: `✓ Accept hunk ${index + 1}/${hunks.length} (${size})`,
        command: 'forgePilot.acceptHunk',
        args: [runId, proposalId, hunk.id],
      },
      {
        line,
        title: '✗ Reject',
        command: 'forgePilot.rejectHunk',
        args: [runId, proposalId, hunk.id],
      },
    );
    if (pending.length > 1 && hunk.id === pending[0].id) {
      lenses.push(
        { line, title: `Accept all ${pending.length}`, command: 'forgePilot.acceptAll', args: [runId, proposalId] },
        { line, title: 'Reject all', command: 'forgePilot.rejectAll', args: [runId, proposalId] },
      );
    }
  });
  return lenses;
}

/** Red for shown-removed lines, green for added lines of undecided hunks. */
export function planDecorations(spans: Map<string, HunkSpan>): PlannedDecorations {
  const added: PlannedDecorations['added'] = [];
  const removed: PlannedDecorations['removed'] = [];
  for (const span of spans.values()) {
    if (span.removed > 0) {
      removed.push({ startLine: span.start, endLine: span.start + span.removed - 1 });
    }
    if (span.added > 0) {
      const first = span.start + span.removed;
      added.push({ startLine: first, endLine: first + span.added - 1 });
    }
  }
  return { added, removed };
}
