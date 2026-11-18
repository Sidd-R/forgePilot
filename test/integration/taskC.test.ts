import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrueForgeClient } from '../../src/trueforge/client';
import { runTurnResilient, type TurnDeps } from '../../src/trueforge/resilience';
import type { WireAgentSpec } from '../../src/trueforge/wire';

const BASE_URL = process.env.FORGEPILOT_BASE_URL ?? 'http://localhost:8790';
const MODEL = 'muse/muse-spark-1-3-contributor';

/**
 * Task C rehearsal at the resilience layer: an unknown primary model
 * fails, the fallback takes over with no user action, and nothing is
 * written (no tools are attached to this turn).
 */
describe('task C: live model fallback', { timeout: 180_000 }, () => {
  it('falls back to the second model automatically', async () => {
    const client = new TrueForgeClient(BASE_URL);
    const deps: TurnDeps = {
      createSession: (spec) => client.createSession(spec),
      streamTurn: (sessionId, input, handler, opts) =>
        client.streamTurn(sessionId, input, handler, opts),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    const spec: WireAgentSpec = {
      model: { name: MODEL },
      instructions: 'Reply with exactly: DONE',
    };
    const notices: string[] = [];
    const result = await runTurnResilient(deps, {
      spec,
      input: 'Reply with exactly: DONE',
      models: ['muse/does-not-exist', MODEL],
      onEvent: () => undefined,
      onNotice: (message) => notices.push(message),
    });
    assert.equal(result.terminal.status, 'done');
    assert.equal(result.model, MODEL);
    assert.equal(notices.length, 1);
    assert.match(notices[0], new RegExp(`Continuing with ${MODEL.replace('/', '/')}`));
  });
});
