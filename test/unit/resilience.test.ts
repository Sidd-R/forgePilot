import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, coversSpec } from '../../src/trueforge/client';
import {
  ExhaustedError,
  RETRY_DELAYS_MS,
  TurnCancelledError,
  classifyFailure,
  runTurnResilient,
  type TurnDeps,
} from '../../src/trueforge/resilience';
import type { TurnTerminal, WireAgentSpec } from '../../src/trueforge/wire';

const SPEC: WireAgentSpec = { model: { name: 'x/y' } };

describe('classifyFailure', () => {
  it('retries timeouts, 429, and 5xx', () => {
    assert.equal(classifyFailure(undefined, 'timed out'), 'retry');
    assert.equal(classifyFailure(429, 'slow down'), 'retry');
    assert.equal(classifyFailure(503, 'unavailable'), 'retry');
    assert.equal(classifyFailure(undefined, 'stream silence timeout'), 'retry');
    assert.equal(classifyFailure(undefined, 'Turn stream ended before turn.done arrived.'), 'retry');
  });

  it('skips to the next model on auth, unknown model, and refused connections', () => {
    assert.equal(classifyFailure(401, 'nope'), 'next-model');
    assert.equal(classifyFailure(undefined, '[Model Error] Request failed (401): invalid API key'), 'next-model');
    assert.equal(classifyFailure(422, 'unknown model foo/bar'), 'next-model');
    assert.equal(classifyFailure(undefined, 'connect ECONNREFUSED 127.0.0.1'), 'next-model');
  });

  it('uses a 1s then 3s backoff', () => {
    assert.deepEqual(RETRY_DELAYS_MS, [1000, 3000]);
  });
});

describe('runTurnResilient', () => {
  function deps(behavior: {
    create?: (spec: WireAgentSpec) => Promise<string>;
    stream?: () => Promise<TurnTerminal>;
  }): TurnDeps & { calls: { models: string[]; streams: number; sleeps: number[] } } {
    const calls = { models: [] as string[], streams: 0, sleeps: [] as number[] };
    return {
      calls,
      createSession: async (spec) => {
        calls.models.push(spec.model.name);
        return behavior.create ? behavior.create(spec) : 's1';
      },
      streamTurn: async () => {
        calls.streams += 1;
        return behavior.stream ? behavior.stream() : { status: 'done' };
      },
      sleep: async (ms) => {
        calls.sleeps.push(ms);
      },
    };
  }

  const noop = (): void => undefined;

  it('succeeds first try without sleeps', async () => {
    const d = deps({});
    const result = await runTurnResilient(d, {
      spec: SPEC,
      input: 'hi',
      models: ['m/primary', 'm/fallback'],
      onEvent: noop,
      onNotice: noop,
    });
    assert.equal(result.model, 'm/primary');
    assert.deepEqual(d.calls.sleeps, []);
    assert.deepEqual(d.calls.models, ['m/primary']);
  });

  it('retries retryable turn errors twice, then falls back', async () => {
    const d = deps({ stream: async () => ({ status: 'error', message: 'timeout' }) });
    const notices: string[] = [];
    await assert.rejects(
      runTurnResilient(d, {
        spec: SPEC,
        input: 'hi',
        models: ['m/one'],
        onEvent: noop,
        onNotice: (m) => notices.push(m),
      }),
      ExhaustedError,
    );
    assert.equal(d.calls.streams, 3);
    assert.deepEqual(d.calls.sleeps, [1000, 3000]);
    assert.deepEqual(notices, []);
  });

  it('recovers when a retry succeeds', async () => {
    let n = 0;
    const d = deps({
      stream: async () => (++n === 1 ? { status: 'error', message: 'timeout' } : { status: 'done' }),
    });
    const result = await runTurnResilient(d, {
      spec: SPEC,
      input: 'hi',
      models: ['m/one'],
      onEvent: noop,
      onNotice: noop,
    });
    assert.equal(result.terminal.status, 'done');
    assert.deepEqual(d.calls.sleeps, [1000]);
  });

  it('skips retries on 401 and uses the fallback with a notice', async () => {
    const d = deps({
      stream: async () => ({ status: 'error', message: '[Model Error] (401): invalid API key' }),
    });
    const realDeps: TurnDeps = {
      ...d,
      streamTurn: async () => {
        d.calls.streams += 1;
        return d.calls.models[d.calls.models.length - 1] === 'm/primary'
          ? { status: 'error', message: 'invalid API key' }
          : { status: 'done' };
      },
    };
    const notices: string[] = [];
    const result = await runTurnResilient(realDeps, {
      spec: SPEC,
      input: 'hi',
      models: ['m/primary', 'm/fallback'],
      onEvent: noop,
      onNotice: (m) => notices.push(m),
    });
    assert.equal(result.model, 'm/fallback');
    assert.deepEqual(d.calls.sleeps, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Continuing with m\/fallback/);
  });

  it('falls back immediately when the model is unknown at create time', async () => {
    const d = deps({
      create: async (spec) => {
        if (spec.model.name === 'm/bad') {
          throw new HttpError('POST', '/api/v1/sessions', 422, 'unknown model');
        }
        return 's2';
      },
    });
    const result = await runTurnResilient(d, {
      spec: SPEC,
      input: 'hi',
      models: ['m/bad', 'm/good'],
      onEvent: noop,
      onNotice: noop,
    });
    assert.equal(result.model, 'm/good');
    assert.deepEqual(d.calls.models, ['m/bad', 'm/good']);
  });

  it('treats silence as a retryable failure', async () => {
    const d = deps({});
    const hanging: TurnDeps = {
      ...d,
      streamTurn: async (_sid, _input, _onEvent, opts) => {
        d.calls.streams += 1;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')));
        });
      },
    };
    await assert.rejects(
      runTurnResilient(hanging, {
        spec: SPEC,
        input: 'hi',
        models: ['m/one'],
        onEvent: noop,
        onNotice: noop,
        silenceTimeoutMs: 20,
      }),
      ExhaustedError,
    );
    assert.equal(d.calls.streams, 3);
  });

  it('never aborts for silence while the turn is paused', async () => {
    const d = deps({});
    const waiting: TurnDeps = {
      ...d,
      streamTurn: async (_sid, _input, onEvent, opts) => {
        d.calls.streams += 1;
        const cursor = { turnId: 't1', lastEventId: 'e0' };
        await onEvent(
          { type: 'tool.approval_required', id: 'p1', thread_id: 'main', tool_calls: [] },
          cursor,
          { sessionId: 's1' },
        );
        // Quiet well past the silence window while paused.
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (opts?.signal?.aborted) {
          throw new Error('aborted while paused');
        }
        await onEvent(
          { type: 'turn.done', id: 'd1', state: { status: 'done' } },
          cursor,
          { sessionId: 's1' },
        );
        return { status: 'done' };
      },
    };
    const result = await runTurnResilient(waiting, {
      spec: SPEC,
      input: 'hi',
      models: ['m/one'],
      onEvent: noop,
      onNotice: noop,
      silenceTimeoutMs: 20,
    });
    assert.equal(result.terminal.status, 'done');
    assert.equal(d.calls.streams, 1);
    assert.deepEqual(d.calls.sleeps, []);
  });

  it('rejects empty model lists', async () => {
    const d = deps({});
    await assert.rejects(
      runTurnResilient(d, { spec: SPEC, input: 'hi', models: [], onEvent: noop, onNotice: noop }),
      /no models configured/,
    );
  });

  it('stops before the first session when already cancelled', async () => {
    const d = deps({});
    const notices: string[] = [];
    await assert.rejects(
      runTurnResilient(d, {
        spec: SPEC,
        input: 'hi',
        models: ['m/one', 'm/two'],
        onEvent: noop,
        onNotice: (m) => notices.push(m),
        isCancelled: () => true,
      }),
      TurnCancelledError,
    );
    assert.deepEqual(d.calls.models, []);
    assert.equal(d.calls.streams, 0);
    assert.deepEqual(d.calls.sleeps, []);
    assert.deepEqual(notices, []);
  });

  it('does not retry or fall back once cancelled mid-flight', async () => {
    let streams = 0;
    const d = deps({
      stream: async () => {
        streams += 1;
        return { status: 'error', message: 'timeout' };
      },
    });
    await assert.rejects(
      runTurnResilient(d, {
        spec: SPEC,
        input: 'hi',
        models: ['m/one', 'm/two'],
        onEvent: noop,
        onNotice: noop,
        isCancelled: () => streams >= 1,
      }),
      TurnCancelledError,
    );
    assert.equal(d.calls.streams, 1);
    assert.deepEqual(d.calls.models, ['m/one']);
    assert.deepEqual(d.calls.sleeps, []);
  });
});

describe('coversSpec', () => {
  it('accepts a stored manifest with server-filled defaults', () => {
    const sent = { model: { name: 'm' }, mcp_servers: [{ name: 'forge-editor', preload: true }] };
    const stored = {
      model: { name: 'm' },
      mcp_servers: [{ name: 'forge-editor', preload: true, disable_tools: [] }],
      config: { memory: { enabled: false } },
    };
    assert.equal(coversSpec(stored, sent), true);
  });

  it('rejects a changed value, model or tool list', () => {
    const sent = { model: { name: 'm' }, instructions: 'new', tools: ['a'] };
    assert.equal(coversSpec({ model: { name: 'm' }, instructions: 'old', tools: ['a'] }, sent), false);
    assert.equal(coversSpec({ model: { name: 'x' }, instructions: 'new', tools: ['a'] }, sent), false);
    assert.equal(coversSpec({ model: { name: 'm' }, instructions: 'new', tools: ['a', 'b'] }, sent), false);
  });
});
