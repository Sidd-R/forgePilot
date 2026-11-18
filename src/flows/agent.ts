import type { TranscriptEvent } from '../types';
import type { TrueForgeClient } from '../trueforge/client';
import { runTurnResilient, type TurnDeps } from '../trueforge/resilience';
import type { TurnEventCallback, WireAgentSpec } from '../trueforge/wire';
import type { ProposalStore } from '../edits/proposals';
import type { ReviewPort } from '../edits/review';
import type { ProposeEditDeps } from '../mcp/tools/propose_edit';
import { createTurnHandler, type CommandChoice } from './turns';

export interface AgentTurnDeps {
  client: TrueForgeClient;
  spec: WireAgentSpec;
  models: string[];
  input: string;
  store: ProposalStore;
  review: ReviewPort;
  proposeDeps: ProposeEditDeps;
  askCommand: (command: string) => Promise<CommandChoice>;
  onTranscript: (event: TranscriptEvent) => void;
  onNotice: (message: string) => void;
  onSession?: (sessionId: string) => void;
  onReviewComplete?: (runId: string, proposalId: string) => void;
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
    onReviewComplete: (runId, proposalId) => deps.onReviewComplete?.(runId, proposalId),
    isCancelled: deps.isCancelled,
  });
  const onEvent: TurnEventCallback = (event, cursor, info) => handler(event, cursor, info);

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
    createSession: (spec) => deps.client.createSession(spec),
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
    });
    return { status: result.terminal.status, model: result.model, sessionId: result.sessionId };
  } catch (err) {
    deps.onNotice(err instanceof Error ? err.message : String(err));
    return { status: 'error', model: '', sessionId: '' };
  }
}
