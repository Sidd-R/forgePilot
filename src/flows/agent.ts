import type { TranscriptEvent } from '../types';
import type { TrueForgeClient } from '../trueforge/client';
import { TurnCancelledError, runTurnResilient, type TurnDeps } from '../trueforge/resilience';
import type { TurnEventCallback, WireAgentSpec } from '../trueforge/wire';
import type { ProposalStore } from '../edits/proposals';
import type { ReviewPort } from '../edits/review';
import type { ProposeEditDeps } from '../mcp/tools/propose_edit';
import { UsageMeter, type TokenUsage } from './usage';
import { createTurnHandler, type CommandChoice } from './turns';

export interface AgentTurnDeps {
  client: TrueForgeClient;
  spec: WireAgentSpec;
  /** Registry agent that primary-model sessions are linked to. */
  agentName?: string;
  models: string[];
  input: string;
  store: ProposalStore;
  review: ReviewPort;
  proposeDeps: ProposeEditDeps;
  askCommand: (command: string) => Promise<CommandChoice>;
  onTranscript: (event: TranscriptEvent) => void;
  onNotice: (message: string) => void;
  onSession?: (sessionId: string) => void;
  onReviewComplete?: (runId: string, proposalId: string, accepted: number, rejected: number) => void;
  /** Running token totals for this turn (all model calls, incl. fallbacks). */
  onUsage?: (usage: TokenUsage) => void;
  isCancelled: () => boolean;
  /** Continue this session instead of starting a resilient first turn. */
  sessionId?: string;
}

export interface AgentTurnResult {
  status: string;
  model: string;
  sessionId: string;
}

/**
 * One agent-mode turn. First turns run through retry-then-fallback;
 * follow-up prompts continue the panel session directly.
 */
export async function runAgentTurn(deps: AgentTurnDeps): Promise<AgentTurnResult> {
  const handler = createTurnHandler({
    client: deps.client,
    rootDir: deps.proposeDeps.rootDir,
    store: deps.store,
    review: deps.review,
    proposeDeps: deps.proposeDeps,
    askCommand: deps.askCommand,
    onTranscript: deps.onTranscript,
    onReviewComplete: (runId, proposalId, accepted, rejected) =>
      deps.onReviewComplete?.(runId, proposalId, accepted, rejected),
    isCancelled: deps.isCancelled,
  });
  const meter = new UsageMeter();
  const onEvent: TurnEventCallback = (event, cursor, info) => {
    if (meter.feed(event)) {
      deps.onUsage?.(meter.total());
    }
    return handler(event, cursor, info);
  };

  if (deps.sessionId) {
    try {
      const terminal = await deps.client.streamTurn(deps.sessionId, deps.input, onEvent);
      return { status: terminal.status, model: '', sessionId: deps.sessionId };
    } catch (err) {
      deps.onNotice(
        `Follow-up failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'error', model: '', sessionId: deps.sessionId };
    }
  }
  const turnDeps: TurnDeps = {
    // Primary-model sessions are linked to the registry agent; fallback
    // models differ from it, so their sessions carry the spec inline.
    createSession: (spec) =>
      deps.client.createSession(spec, spec.model.name === deps.models[0] ? deps.agentName : undefined),
    streamTurn: (sessionId, input, handlerFn, opts) =>
      deps.client.streamTurn(sessionId, input, handlerFn, opts),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  try {
    const result = await runTurnResilient(turnDeps, {
      spec: deps.spec,
      input: deps.input,
      models: deps.models,
      onEvent,
      onNotice: deps.onNotice,
      onSession: deps.onSession,
      isCancelled: deps.isCancelled,
    });
    return { status: result.terminal.status, model: result.model, sessionId: result.sessionId };
  } catch (err) {
    if (err instanceof TurnCancelledError || deps.isCancelled()) {
      return { status: 'cancelled', model: '', sessionId: '' };
    }
    deps.onNotice(err instanceof Error ? err.message : String(err));
    return { status: 'error', model: '', sessionId: '' };
  }
}
