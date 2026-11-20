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

  it('exposes live events before finalize', () => {
    const storage = memoryStore();
    const history = new ChatHistory(storage);
    assert.deepEqual(history.liveEvents(), []);
    history.beginPrompt('live');
    history.append([event('a')]);
    assert.deepEqual(
      history.liveEvents().map((e) => e.text),
      ['a'],
    );
    history.finalize();
    assert.deepEqual(history.liveEvents(), []);
  });

  it('caps events per chat', () => {
    const storage = memoryStore();
    const history = new ChatHistory(storage);
    history.beginPrompt('long');
    history.append(Array.from({ length: 1200 }, (_, i) => event(`e${i}`)));
    history.finalize();
    assert.equal(history.open(history.list()[0].id).length, 1000);
  });

  it('folds streamed deltas into their message so the cap holds whole runs', () => {
    const store = memoryStore();
    const history = new ChatHistory(store);
    history.beginPrompt('stream');
    history.append([{ kind: 'text', text: '', id: 'm1' }]);
    for (let i = 0; i < 2000; i += 1) {
      history.append([{ kind: 'text', text: 'x', id: 'm1', delta: true }]);
    }
    history.append([{ kind: 'status', text: 'done' }]);
    const live = history.liveEvents();
    assert.equal(live.length, 2);
    assert.equal(live[0].text.length, 2000);
    assert.equal(live[1].text, 'done');
  });
});
