import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildInlineInput } from '../../src/inline/controller';
import { createTurnHandler } from '../../src/flows/turns';
import { ProposalStore } from '../../src/edits/proposals';
import { applyPreparedProposal } from '../../src/mcp/tools/propose_edit';
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

describe('batched review orchestration', () => {
  it('opens every file and answers once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpbatch-'));
    fs.writeFileSync(path.join(root, 'a.py'), 'a = 1\n');
    fs.writeFileSync(path.join(root, 'b.py'), 'b = 2\n');
    const store = new ProposalStore();
    const opened: string[] = [];
    const answers: boolean[] = [];
    const handler = createTurnHandler({
      client: {
        answerApproval: (_s: string, _t: string, _a: never, allow: boolean) => {
          answers.push(allow);
          return Promise.resolve();
        },
      } as never,
      rootDir: root,
      store,
      review: {
        open: (_root: string, runId: string, proposalId: string) => {
          opened.push(proposalId);
          const proposal = store.getProposal(runId, proposalId);
          assert.ok(proposal);
          for (const hunk of proposal.hunks) {
            store.decide(runId, proposalId, hunk.id, 'accepted');
          }
          return Promise.resolve({
            accepted: proposal.hunks.map((h) => h.id),
            rejected: [],
          });
        },
      },
      proposeDeps: {
        rootDir: root,
        store,
        readText: (rel: string) =>
          fs.promises.readFile(path.join(root, rel), 'utf8').catch((): null => null),
        writeFinal: (rel: string, text: string) => fs.promises.writeFile(path.join(root, rel), text),
      },
      askCommand: () => Promise.resolve('deny' as const),
      isCancelled: () => false,
    });
    const args = {
      files: [
        { path: 'a.py', edits: [{ old_text: 'a = 1', new_text: 'a = 10' }] },
        { path: 'b.py', edits: [{ old_text: 'b = 2', new_text: 'b = 20' }] },
      ],
    };
    const cursor = { turnId: 't1', lastEventId: 'e0' };
    await handler(
      {
        type: 'model.message',
        id: 'e1',
        tool_calls: [
          { id: 'call_1', function: { name: 'propose_edit', arguments: JSON.stringify(args) } },
        ],
      },
      cursor,
      { sessionId: 's1' },
    );
    await handler(
      {
        type: 'tool.approval_required',
        id: 'p1',
        thread_id: 'main',
        tool_calls: [{ id: 'call_1', source_event_id: 'e1' }],
      },
      cursor,
      { sessionId: 's1' },
    );
    assert.deepEqual(opened.length, 2);
    assert.deepEqual(answers, [true]);
    const outcome = await applyPreparedProposal(
      {
        rootDir: root,
        store,
        readText: (rel: string) =>
          fs.promises.readFile(path.join(root, rel), 'utf8').catch((): null => null),
        writeFinal: (rel: string, text: string) => fs.promises.writeFile(path.join(root, rel), text),
      },
      args,
    );
    assert.equal(outcome.applied.length, 2);
    assert.equal(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), 'a = 10\n');
    assert.equal(fs.readFileSync(path.join(root, 'b.py'), 'utf8'), 'b = 20\n');
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
