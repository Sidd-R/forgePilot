import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Hunk } from '../../src/types';
import { layoutReview, planDecorations, planLenses } from '../../src/edits/reviewPlan';
import { applyHunks } from '../../src/edits/diff';

const before = 'a\nb\nc\nd\ne\nf';
const hunks: Hunk[] = [
  { id: 'h1', startLine: 2, oldLines: ['b'], newLines: ['B1', 'B2'] },
  { id: 'h2', startLine: 5, oldLines: [], newLines: ['new'] },
];

describe('layoutReview', () => {
  it('shows old then new lines for undecided hunks', () => {
    const layout = layoutReview(before, hunks, new Set(), new Set());
    assert.equal(layout.text, 'a\nb\nB1\nB2\nc\nd\nnew\ne\nf');
    assert.deepEqual(layout.spans.get('h1'), { start: 2, removed: 1, added: 2 });
    assert.deepEqual(layout.spans.get('h2'), { start: 7, removed: 0, added: 1 });
  });

  it('collapses decided hunks to their chosen side', () => {
    const accepted = layoutReview(before, hunks, new Set(['h1']), new Set(['h1']));
    assert.equal(accepted.text, 'a\nB1\nB2\nc\nd\nnew\ne\nf');
    assert.deepEqual(accepted.spans.get('h2'), { start: 6, removed: 0, added: 1 });
    const rejected = layoutReview(before, hunks, new Set(['h1', 'h2']), new Set());
    assert.equal(rejected.text, before);
    assert.equal(rejected.spans.size, 0);
  });

  it('matches applyHunks once every hunk is decided', () => {
    const accepted = new Set(['h2']);
    const layout = layoutReview(before, hunks, new Set(['h1', 'h2']), accepted);
    assert.equal(layout.text, applyHunks(before, hunks, accepted));
  });
});

describe('planDecorations', () => {
  it('colors removed lines red and added lines green', () => {
    const { spans } = layoutReview(before, hunks, new Set(), new Set());
    assert.deepEqual(planDecorations(spans), {
      removed: [{ startLine: 2, endLine: 2 }],
      added: [
        { startLine: 3, endLine: 4 },
        { startLine: 7, endLine: 7 },
      ],
    });
  });
});

describe('planLenses', () => {
  it('shows per-hunk buttons only for undecided hunks', () => {
    const { spans } = layoutReview(before, hunks, new Set(['h1']), new Set(['h1']));
    assert.deepEqual(planLenses('r1', 'p1', hunks, spans), [
      { line: 6, title: '✓ Accept hunk 2/2 (+1 −0)', command: 'forgePilot.acceptHunk', args: ['r1', 'p1', 'h2'] },
      { line: 6, title: '✗ Reject', command: 'forgePilot.rejectHunk', args: ['r1', 'p1', 'h2'] },
    ]);
  });

  it('adds file-level accept/reject all on the first pending hunk', () => {
    const { spans } = layoutReview(before, hunks, new Set(), new Set());
    const all = planLenses('r1', 'p1', hunks, spans).filter((lens) => lens.command.endsWith('All'));
    assert.deepEqual(
      all.map((lens) => [lens.line, lens.title, lens.args]),
      [
        [2, 'Accept all 2', ['r1', 'p1']],
        [2, 'Reject all', ['r1', 'p1']],
      ],
    );
  });

  it('shows nothing once every hunk is decided', () => {
    const { spans } = layoutReview(before, hunks, new Set(['h1', 'h2']), new Set());
    assert.deepEqual(planLenses('r1', 'p1', hunks, spans), []);
  });
});
