import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFencedBlock } from '../../src/inline/fenced';

describe('parseFencedBlock', () => {
  it('takes the first fenced block only', () => {
    const reply = 'Here you go:\n```python\nx = 1\n```\nDone.\n```\ny = 2\n```\n';
    assert.equal(parseFencedBlock(reply), 'x = 1');
  });

  it('accepts bare fences', () => {
    assert.equal(parseFencedBlock('```\nhello\n```'), 'hello');
  });

  it('returns null without fences or with unclosed fences', () => {
    assert.equal(parseFencedBlock('just prose'), null);
    assert.equal(parseFencedBlock('```python\nx = 1\n'), null);
    assert.equal(parseFencedBlock('```\n```'), null);
  });

  it('keeps inner indentation intact', () => {
    const reply = '```\n    indented\n        deeper\n```';
    assert.equal(parseFencedBlock(reply), '    indented\n        deeper');
  });
});
