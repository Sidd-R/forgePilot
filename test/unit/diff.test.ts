import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, computeHunks } from '../../src/edits/diff';

describe('computeHunks', () => {
  it('yields no hunks for identical text', () => {
    assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
  });

  it('makes one hunk for a single-line change', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nB\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].startLine, 2);
    assert.deepEqual(hunks[0].oldLines, ['b']);
    assert.deepEqual(hunks[0].newLines, ['B']);
  });

  it('merges changes within three lines', () => {
    const oldText = 'l1\nl2\nl3\nl4\nl5\nl6\n';
    const newText = 'l1\nL2\nl3\nl4\nL5\nl6\n';
    const hunks = computeHunks(oldText, newText);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].startLine, 2);
  });

  it('splits changes more than three lines apart', () => {
    const oldText = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
    const newText = 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nL8\n';
    const hunks = computeHunks(oldText, newText);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].startLine, 2);
    assert.equal(hunks[1].startLine, 8);
  });

  it('handles pure insertion at the start', () => {
    const hunks = computeHunks('b\nc\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].startLine, 1);
    assert.deepEqual(hunks[0].oldLines, []);
    assert.deepEqual(hunks[0].newLines, ['a']);
  });

  it('handles pure deletion at the end', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].oldLines, ['c']);
    assert.deepEqual(hunks[0].newLines, []);
  });

  it('handles empty original text', () => {
    const hunks = computeHunks('', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(
      applyHunks('', hunks, new Set(hunks.map((h) => h.id))),
      'a\nb\n',
    );
  });
});

describe('applyHunks', () => {
  it('applies only accepted hunks', () => {
    const oldText = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
    const newText = 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nL8\n';
    const hunks = computeHunks(oldText, newText);
    assert.equal(hunks.length, 2);
    const out = applyHunks(oldText, hunks, new Set([hunks[0].id]));
    assert.equal(out, 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  });

  it('accepting everything reproduces the new text', () => {
    const oldText = 'a\nb\nc\nd\n';
    const newText = 'a\nB\nC\nd\ne\n';
    const hunks = computeHunks(oldText, newText);
    const out = applyHunks(
      oldText,
      hunks,
      new Set(hunks.map((h) => h.id)),
    );
    assert.equal(out, newText);
  });

  it('accepting nothing keeps the old text', () => {
    const oldText = 'a\nb\n';
    const hunks = computeHunks(oldText, 'A\nB\n');
    assert.equal(applyHunks(oldText, hunks, new Set()), oldText);
  });
});
