import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHistory, type ChatRecord, type ChatStorage } from '../../src/panel/history';
import type { TranscriptEvent } from '../../src/types';

function memoryStore(records: ChatRecord[] = []): ChatStorage & { records: ChatRecord[] } {
  const store = {
    records,
    get: () => store.records,
    set: (next: ChatRecord[]) => {
      store.records = next;
    },
  };
  return store;
}

const event = (text: string): TranscriptEvent => ({ kind: 'text', text });

describe('ChatHistory', () => {
  it('saves the live chat on finalize and reopens it', () => {
    const storage = memoryStore();
    const history = new ChatHistory(storage);
    history.beginPrompt('do the thing');
    history.append([event('a'), event('b')]);
    history.finalize();
    const list = history.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'do the thing');
    assert.deepEqual(history.open(list[0].id).map((e) => e.text), ['a', 'b']);
  });

  it('skips empty chats and unknown ids', () => {
    const storage = memoryStore();
    const history = new ChatHistory(storage);
    history.beginPrompt('nothing');
    history.finalize();
    assert.deepEqual(history.list(), []);
    assert.deepEqual(history.open('nope'), []);
  });

  it('caps stored chats at twenty, newest first', () => {
    const storage = memoryStore();
    const history = new ChatHistory(storage);
    for (let i = 0; i < 25; i++) {
      history.beginPrompt(`chat ${i}`);
      history.append([event('x')]);
      history.finalize();
    }
    const list = history.list();
    assert.equal(list.length, 20);
    assert.equal(list[0].title, 'chat 24');
  });

  it('caps events per chat', () => {
    const storage = memoryStore();
    const history = new ChatHistory(storage);
    history.beginPrompt('long');
    history.append(Array.from({ length: 1200 }, (_, i) => event(`e${i}`)));
    history.finalize();
    assert.equal(history.open(history.list()[0].id).length, 1000);
  });
});
