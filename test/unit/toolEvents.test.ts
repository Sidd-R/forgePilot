import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnHandler } from '../../src/flows/turns';
import { ProposalStore } from '../../src/edits/proposals';
import type { TranscriptEvent } from '../../src/types';

describe('tool activity transcript', () => {
  it('reports harness-run tools with their target once they respond', async () => {
    const events: TranscriptEvent[] = [];
    const handler = createTurnHandler({
      client: { answerApproval: () => Promise.resolve() } as never,
      rootDir: '/r',
      store: new ProposalStore(),
      review: { open: () => Promise.reject(new Error('unused')) },
      proposeDeps: {} as never,
      askCommand: () => Promise.resolve('deny' as const),
      onTranscript: (event) => events.push(event),
      isCancelled: () => false,
    });
    const cursor = { turnId: 't1', lastEventId: 'e0' };
    const info = { sessionId: 's1' };
    await handler({ type: 'model.message', id: 'm1', tool_calls: [] }, cursor, info);
    await handler(
      {
        type: 'model.message.delta',
        id: 'm1',
        tool_calls: [
          { id: 'c1', function: { name: 'read_file', arguments: '{"path":"src/cli.py"}' } },
          { id: 'c2', function: { name: 'propose_edit', arguments: '{"path":"a.py"}' } },
        ],
      },
      cursor,
      info,
    );
    await handler({ type: 'tool.response', id: 'r1', tool_call_id: 'c1', content: 'abc' }, cursor, info);
    await handler({ type: 'tool.response', id: 'r2', tool_call_id: 'c2', content: 'ok' }, cursor, info);
    await handler({ type: 'tool.response', id: 'r3', tool_call_id: 'zz', content: '' }, cursor, info);
    const tools = events.filter((event) => event.kind === 'tool_call');
    assert.equal(tools.length, 1, 'approval tools and unknown ids are not repeated');
    assert.equal(tools[0].tool, 'read_file');
    assert.equal(tools[0].text, 'src/cli.py');
    assert.equal(tools[0].resultBytes, 3);
  });
});
