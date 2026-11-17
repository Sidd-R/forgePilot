import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInlineInput } from '../../src/inline/controller';
import {
  MessageBuffer,
  mergeDelta,
  messageText,
  toolCallFromMessage,
} from '../../src/flows/messages';
import type { WireEvent } from '../../src/trueforge/wire';

describe('buildInlineInput', () => {
  it('marks the selection editable and the context read-only', () => {
    const input = buildInlineInput(
      {
        rootDir: '/r',
        relPath: 'a.py',
        startLine: 4,
        endLine: 5,
        selectedText: 'x = 1\n',
        beforeText: 'import os\n',
        afterText: 'print(x)\n',
      },
      'double it',
    );
    assert.match(input, /Instruction: double it/);
    assert.match(input, /File: a\.py/);
    assert.match(input, /Selected lines 4-5 \(edit ONLY this range\)/);
    assert.match(input, /Read-only context before/);
    assert.match(input, /Read-only context after/);
  });
});

describe('toolCallFromMessage', () => {
  const event = {
    type: 'model.message',
    id: 'e1',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'propose_edit', arguments: '{"path":"a.py"}' },
      },
    ],
  } as unknown as WireEvent;

  it('extracts name and parsed args', () => {
    assert.deepEqual(toolCallFromMessage(event, 'call_1'), {
      name: 'propose_edit',
      args: { path: 'a.py' },
    });
  });

  it('returns undefined for unknown ids and bad JSON', () => {
    assert.equal(toolCallFromMessage(event, 'call_9'), undefined);
    assert.equal(toolCallFromMessage({ type: 'model.message', id: 'e2' }, 'call_1'), undefined);
    const bad = {
      type: 'model.message',
      id: 'e3',
      tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{nope' } }],
    } as unknown as WireEvent;
    assert.equal(toolCallFromMessage(bad, 'c'), undefined);
  });
});

describe('mergeDelta and MessageBuffer', () => {
  it('concatenates content fragments by message id', () => {
    const buffer = new MessageBuffer();
    buffer.feed({ type: 'model.message', id: 'm1' });
    buffer.feed({ type: 'model.message.delta', id: 'm1', content: 'one two ' });
    buffer.feed({ type: 'model.message.delta', id: 'm1', content: 'three' });
    assert.deepEqual(buffer.texts(), ['one two three']);
  });

  it('merges tool calls by id with arguments concatenated', () => {
    const base = { type: 'model.message', id: 'm1' };
    const first = {
      type: 'model.message.delta',
      id: 'm1',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit', arguments: '{"a":' } }],
    };
    const second = {
      type: 'model.message.delta',
      id: 'm1',
      tool_calls: [{ id: 'c1', function: { arguments: '1}' } }],
    };
    const merged = mergeDelta(mergeDelta(base, first), second);
    assert.deepEqual(toolCallFromMessage(merged, 'c1'), {
      name: 'edit',
      args: { a: 1 },
    });
  });

  it('keeps messages separate by id', () => {
    const buffer = new MessageBuffer();
    buffer.feed({ type: 'model.message', id: 'm1' });
    buffer.feed({ type: 'model.message.delta', id: 'm1', content: 'first' });
    buffer.feed({ type: 'model.message', id: 'm2' });
    buffer.feed({ type: 'model.message.delta', id: 'm2', content: 'second' });
    assert.deepEqual(buffer.texts(), ['first', 'second']);
  });
});

describe('messageText', () => {
  it('reads string, parts, and delta shapes', () => {
    assert.equal(messageText({ type: 'm', id: '1', content: 'hi' }), 'hi');
    assert.equal(
      messageText({ type: 'm', id: '2', content: [{ text: 'a' }, { text: 'b' }] }),
      'ab',
    );
    assert.equal(messageText({ type: 'd', id: '3', delta: 'frag' }), 'frag');
    assert.equal(messageText({ type: 'd', id: '4', delta: { text: 'frag' } }), 'frag');
    assert.equal(messageText({ type: 'm', id: '5' }), '');
  });
});
