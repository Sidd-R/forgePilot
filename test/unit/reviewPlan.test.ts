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
    const titles = lenses.map((lens) => lens.title);
    assert.ok(!titles.some((title) => title.includes('h1')));
    assert.deepEqual(
      lenses.filter((lens) => lens.title.includes('h2')),
      [
        {
          line: 21,
          title: '✓ Accept h2',
          command: 'forgePilot.acceptHunk',
          args: ['r1', 'p1', 'h2'],
        },
        {
          line: 21,
          title: '✗ Reject h2',
          command: 'forgePilot.rejectHunk',
          args: ['r1', 'p1', 'h2'],
        },
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
    assert.deepEqual(plan.removed, [{ line: 21, text: 'old two' }]);
  });

  it('clears every color once every hunk is decided', () => {
    assert.deepEqual(planDecorations(hunks, new Set(['h1', 'h2']), starts), {
      added: [],
      removed: [],
    });
  });
});
