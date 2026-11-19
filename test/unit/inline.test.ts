import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInlineEdit, selectNewErrors, type InlineDeps } from '../../src/inline/controller';
import { ProposalStore } from '../../src/edits/proposals';
import type { ReviewPort, ReviewResult } from '../../src/edits/review';
import type { ProposeEditDeps } from '../../src/mcp/tools/propose_edit';
import type { TrueForgeClient } from '../../src/trueforge/client';
import type { DiagnosticItem } from '../../src/mcp/tools/get_diagnostics';
import type { TurnEventCallback, WireEvent } from '../../src/trueforge/wire';

describe('selectNewErrors', () => {
  const err = (line: number, message: string): DiagnosticItem => ({
    path: 'a.py',
    line,
    severity: 'error',
    message,
  });
  const warn = (line: number, message: string): DiagnosticItem => ({
    path: 'a.py',
    line,
    severity: 'warning',
    message,
  });

  it('keeps only errors absent before the edit', () => {
    const before = [err(1, 'old'), warn(2, 'w')];
    const after = [err(1, 'old'), err(3, 'new'), warn(4, 'w2')];
    assert.deepEqual(selectNewErrors(before, after), [err(3, 'new')]);
  });

  it('returns nothing when errors are unchanged', () => {
    const before = [err(1, 'old')];
    assert.deepEqual(selectNewErrors(before, [...before]), []);
  });
});

describe('runInlineEdit run termination', () => {
  let root = '';
  let store: ProposalStore;
  let proposeDeps: ProposeEditDeps;
  let reviewsOpened = 0;
  let streamCalls = 0;
  const answers: Array<{ allow: boolean; reason?: string }> = [];

  const review: ReviewPort = {
    open: (_root, runId, proposalId, _newText): Promise<ReviewResult> => {
      reviewsOpened += 1;
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
  };

  function message(id: string, callId: string, args: unknown): WireEvent {
    return {
      type: 'model.message',
      id,
      tool_calls: [
        { id: callId, function: { name: 'propose_edit', arguments: JSON.stringify(args) } },
      ],
    };
  }

  function approval(callId: string, sourceEventId: string): WireEvent {
    return {
      type: 'tool.approval_required',
      id: `pause-${callId}`,
      thread_id: 'main',
      tool_calls: [{ id: callId, source_event_id: sourceEventId }],
    };
  }

  function scriptedClient(scripts: Array<(fire: TurnEventCallback) => Promise<unknown>>): TrueForgeClient {
    return {
      createSession: () => Promise.resolve('s1'),
      streamTurn: (_sessionId: string, _input: string, onEvent: TurnEventCallback) => {
        const script = scripts[Math.min(streamCalls, scripts.length - 1)];
        streamCalls += 1;
        return script(onEvent).then(() => ({ status: 'done' }));
      },
      answerApproval: (_s: string, _t: string, _a: never, allow: boolean, reason?: string) => {
        answers.push({ allow, reason });
        return Promise.resolve();
      },
    } as unknown as TrueForgeClient;
  }

  function depsFor(
    client: TrueForgeClient,
    diagnostics: (rel: string) => DiagnosticItem[],
    notices: string[] = [],
  ): InlineDeps {
    return {
      client,
      spec: { model: { name: 'm/x' } },
      models: ['m/x'],
      target: {
        rootDir: root,
        relPath: 'a.py',
        startLine: 1,
        endLine: 1,
        selectedText: 'x = 1\n',
        beforeText: '',
        afterText: '',
      },
      instruction: 'bump it',
      store,
      review,
      proposeDeps,
      readFullText: () => fs.promises.readFile(path.join(root, 'a.py'), 'utf8'),
      diagnostics,
      onNotice: (message: string) => notices.push(message),
      isCancelled: () => false,
    };
  }

  const editArgs = { path: 'a.py', edits: [{ old_text: 'x = 1', new_text: 'x = 2' }] };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpinline-'));
    fs.writeFileSync(path.join(root, 'a.py'), 'x = 1\n');
    store = new ProposalStore();
    proposeDeps = {
      rootDir: root,
      store,
      readText: (rel) => fs.promises.readFile(path.join(root, rel), 'utf8').catch(() => null),
      writeFinal: (rel, text) => fs.promises.writeFile(path.join(root, rel), text),
    };
    reviewsOpened = 0;
    streamCalls = 0;
    answers.length = 0;
  });

  it('stops after one review when diagnostics are pre-existing', async () => {
    const old: DiagnosticItem[] = [{ path: 'a.py', line: 1, severity: 'error', message: 'old' }];
    const client = scriptedClient([
      (fire) => {
        const cursor = { turnId: 't1', lastEventId: 'e0' };
        return Promise.resolve()
          .then(() => fire(message('e1', 'call_1', editArgs), cursor, { sessionId: 's1' }))
          .then(() => fire(approval('call_1', 'e1'), cursor, { sessionId: 's1' }));
      },
    ]);
    const outcome = await runInlineEdit(depsFor(client, () => old));
    assert.equal(outcome, 'applied');
    assert.equal(reviewsOpened, 1);
    assert.equal(streamCalls, 1);
    assert.deepEqual(answers, [{ allow: true, reason: undefined }]);
  });

  it('repairs errors introduced by the edit', async () => {
    const fresh: DiagnosticItem[] = [{ path: 'a.py', line: 1, severity: 'error', message: 'new' }];
    const client = scriptedClient([
      (fire) => {
        const cursor = { turnId: 't1', lastEventId: 'e0' };
        return Promise.resolve()
          .then(() => fire(message('e1', 'call_1', editArgs), cursor, { sessionId: 's1' }))
          .then(() => fire(approval('call_1', 'e1'), cursor, { sessionId: 's1' }));
      },
      () => Promise.resolve(),
    ]);
    let reads = 0;
    const counting = (): DiagnosticItem[] => {
      reads += 1;
      return reads <= 1 ? [] : reads === 2 ? fresh : [];
    };
    const outcome = await runInlineEdit(depsFor(client, counting));
    assert.equal(outcome, 'applied');
    assert.equal(streamCalls, 2);
  });

  it('falls back to the fenced block when tool calls were denied pre-review', async () => {
    const badArgs = { path: 'a.py', edits: [{ old_text: 'zzz-nope', new_text: 'q' }] };
    const client = scriptedClient([
      (fire) => {
        const cursor = { turnId: 't1', lastEventId: 'e0' };
        return Promise.resolve()
          .then(() => fire(message('e1', 'call_1', badArgs), cursor, { sessionId: 's1' }))
          .then(() => fire(approval('call_1', 'e1'), cursor, { sessionId: 's1' }))
          .then(() =>
            fire(
              { type: 'model.message', id: 'e2', content: 'Here:\n```\nx = 5\n```' },
              cursor,
              { sessionId: 's1' },
            ),
          );
      },
    ]);
    const outcome = await runInlineEdit(depsFor(client, () => []));
    assert.equal(outcome, 'applied');
    assert.equal(reviewsOpened, 1);
    assert.equal(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), 'x = 5\n');
  });

  it('explains the failure when no review and no fenced block exist', async () => {
    const badArgs = { path: 'a.py', edits: [{ old_text: 'zzz-nope', new_text: 'q' }] };
    const client = scriptedClient([
      (fire) => {
        const cursor = { turnId: 't1', lastEventId: 'e0' };
        return Promise.resolve()
          .then(() => fire(message('e1', 'call_1', badArgs), cursor, { sessionId: 's1' }))
          .then(() => fire(approval('call_1', 'e1'), cursor, { sessionId: 's1' }))
          .then(() =>
            fire(
              { type: 'model.message', id: 'e2', content: 'Sorry, I could not do it.' },
              cursor,
              { sessionId: 's1' },
            ),
          );
      },
    ]);
    const notices: string[] = [];
    const outcome = await runInlineEdit(depsFor(client, () => [], notices));
    assert.equal(outcome, 'failed');
    assert.equal(reviewsOpened, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /old_text did not match/);
  });

  it('reports already-applied edits instead of failing silently', async () => {
    fs.writeFileSync(path.join(root, 'a.py'), 'x = 2\n');
    const staleArgs = { path: 'a.py', edits: [{ old_text: 'x = 1', new_text: 'x = 2' }] };
    const client = scriptedClient([
      (fire) => {
        const cursor = { turnId: 't1', lastEventId: 'e0' };
        return Promise.resolve()
          .then(() => fire(message('e1', 'call_1', staleArgs), cursor, { sessionId: 's1' }))
          .then(() => fire(approval('call_1', 'e1'), cursor, { sessionId: 's1' }))
          .then(() =>
            fire(
              { type: 'model.message', id: 'e2', content: 'Looks done already.' },
              cursor,
              { sessionId: 's1' },
            ),
          );
      },
    ]);
    const notices: string[] = [];
    const outcome = await runInlineEdit(depsFor(client, () => [], notices));
    assert.equal(outcome, 'failed');
    assert.equal(reviewsOpened, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /already contains/);
  });

  it('denies a second proposal in the same turn', async () => {
    const client = scriptedClient([
      (fire) => {
        const cursor = { turnId: 't1', lastEventId: 'e0' };
        return Promise.resolve()
          .then(() => fire(message('e1', 'call_1', editArgs), cursor, { sessionId: 's1' }))
          .then(() => fire(approval('call_1', 'e1'), cursor, { sessionId: 's1' }))
          .then(() => fire(message('e2', 'call_2', editArgs), cursor, { sessionId: 's1' }))
          .then(() => fire(approval('call_2', 'e2'), cursor, { sessionId: 's1' }));
      },
    ]);
    const outcome = await runInlineEdit(depsFor(client, () => []));
    assert.equal(outcome, 'applied');
    assert.equal(reviewsOpened, 1);
    assert.equal(answers.length, 2);
    assert.equal(answers[0].allow, true);
    assert.equal(answers[1].allow, false);
    assert.match(answers[1].reason ?? '', /one proposal per turn/);
  });
});
