import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptStore } from '../../src/panel/transcript';

describe('TranscriptStore', () => {
  it('assembles base plus deltas on one visible line', () => {
    const store = new TranscriptStore();
    const base = store.append({ kind: 'text', text: '', id: 'm1' });
    assert.equal(base.created, true);
    assert.equal(base.text, '');
    const first = store.append({ kind: 'text', text: 'Hello ', id: 'm1', delta: true });
    assert.equal(first.created, false);
    assert.equal(first.key, 'm1');
    const second = store.append({ kind: 'text', text: 'there', id: 'm1', delta: true });
    assert.equal(second.text, 'Hello there');
  });

  it('keeps message ids separate', () => {
    const store = new TranscriptStore();
    store.append({ kind: 'text', text: 'one', id: 'm1' });
    const other = store.append({ kind: 'text', text: 'two', id: 'm2' });
    assert.equal(other.created, true);
    assert.equal(other.text, 'two');
  });

  it('gives id-less events their own lines', () => {
    const store = new TranscriptStore();
    const first = store.append({ kind: 'tool_call', text: 'read_file' });
    const second = store.append({ kind: 'tool_call', text: 'read_file' });
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.key, second.key);
  });
});
