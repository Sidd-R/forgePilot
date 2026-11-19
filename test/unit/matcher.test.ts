import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MatchError, findOldText, isAlreadyApplied } from '../../src/edits/matcher';

describe('findOldText', () => {
  it('finds a unique exact match', () => {
    const full = 'def f():\n    return 1\n';
    const match = findOldText(full, '    return 1\n');
    assert.equal(full.slice(match.index, match.index + match.length), '    return 1\n');
  });

  it('rejects matches that repeat', () => {
    assert.throws(() => findOldText('x\nx\n', 'x\n'), MatchError);
  });

  it('tolerates indentation differences', () => {
    const full = 'def f():\n        return  1\n';
    const match = findOldText(full, '  return 1');
    assert.equal(full.slice(match.index, match.index + match.length), '        return  1');
  });

  it('tolerates inner whitespace differences', () => {
    const full = 'x = f(1,  2)\n';
    const match = findOldText(full, 'x = f(1, 2)');
    assert.equal(full.slice(match.index, match.index + match.length), 'x = f(1,  2)');
  });

  it('matches multi-line blocks tolerantly', () => {
    const full = 'a = 1\n    b = 2\nc = 3\n';
    const match = findOldText(full, 'a = 1\nb = 2');
    assert.equal(full.slice(match.index, match.index + match.length), 'a = 1\n    b = 2');
  });

  it('reports the nearest candidate when nothing matches', () => {
    try {
      findOldText('def alpha():\n    return 1\n', 'def beta():\n    return 2\n');
      assert.fail('expected MatchError');
    } catch (err) {
      assert.ok(err instanceof MatchError);
      assert.match(err.message, /Nearest candidate/);
      assert.match(err.message, /def alpha/);
    }
  });

  it('rejects empty old_text', () => {
    assert.throws(() => findOldText('abc', ''), MatchError);
  });
});

describe('isAlreadyApplied', () => {
  it('detects fully applied edits', () => {
    assert.equal(isAlreadyApplied('x = 2\n', [{ old_text: 'x = 1', new_text: 'x = 2' }]), true);
  });

  it('rejects partial application and empty edits', () => {
    assert.equal(
      isAlreadyApplied('x = 2\n', [
        { old_text: 'x = 1', new_text: 'x = 2' },
        { old_text: 'y = 1', new_text: 'y = 2' },
      ]),
      false,
    );
    assert.equal(isAlreadyApplied('x = 2\n', []), false);
    assert.equal(isAlreadyApplied('x = 2\n', undefined), false);
  });
});
