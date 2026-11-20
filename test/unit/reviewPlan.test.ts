import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Hunk } from '../../src/types';
import { planDecorations, planLenses } from '../../src/edits/reviewPlan';

const hunks: Hunk[] = [
  { id: 'h1', startLine: 10, oldLines: ['old one'], newLines: ['new one', 'extra'] },
  { id: 'h2', startLine: 20, oldLines: ['old two'], newLines: ['new two'] },
];
const starts = new Map([
  ['h1', 10],
  ['h2', 21],
]);

describe('planLenses', () => {
  it('shows per-hunk buttons only for undecided hunks', () => {
    const lenses = planLenses('r1', 'p1', hunks, new Set(['h1']), starts);
    assert.ok(!lenses.some((lens) => lens.args.includes('h1')));
    assert.deepEqual(lenses, [
      {
        line: 21,
        title: '✓ Accept hunk 2/2 (+1 −1)',
        command: 'forgePilot.acceptHunk',
        args: ['r1', 'p1', 'h2'],
      },
      {
        line: 21,
        title: '✗ Reject',
        command: 'forgePilot.rejectHunk',
        args: ['r1', 'p1', 'h2'],
      },
    ]);
  });

  it('adds file-level accept/reject all on the first pending hunk', () => {
    const lenses = planLenses('r1', 'p1', hunks, new Set(), starts);
    const all = lenses.filter((lens) => lens.command.endsWith('All'));
    assert.deepEqual(
      all.map((lens) => [lens.line, lens.title, lens.args]),
      [
        [10, 'Accept all 2', ['r1', 'p1']],
        [10, 'Reject all', ['r1', 'p1']],
      ],
    );
  });

  it('shows no buttons once every hunk is decided', () => {
    assert.deepEqual(planLenses('r1', 'p1', hunks, new Set(['h1', 'h2']), starts), []);
  });
});

describe('planDecorations', () => {
  it('colors only undecided hunks', () => {
    const plan = planDecorations(hunks, new Set(['h1']), starts);
    assert.deepEqual(plan.added, [{ startLine: 21, endLine: 21 }]);
    assert.deepEqual(plan.removed, [{ line: 21, text: 'old two', count: 1 }]);
  });

  it('counts removed lines for the chip', () => {
    const plan = planDecorations(
      [{ id: 'h1', startLine: 5, oldLines: ['a', 'b', 'c'], newLines: ['z'] }],
      new Set(),
      new Map([['h1', 5]]),
    );
    assert.deepEqual(plan.removed, [{ line: 5, text: 'a\nb\nc', count: 3 }]);
  });

  it('clears every color once every hunk is decided', () => {
    assert.deepEqual(planDecorations(hunks, new Set(['h1', 'h2']), starts), {
      added: [],
      removed: [],
    });
  });
});
