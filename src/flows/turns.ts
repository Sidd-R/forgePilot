import type { TranscriptEvent } from '../types';
import type { TrueForgeClient } from '../trueforge/client';
import type { ApprovalRequest, TurnEventCallback } from '../trueforge/wire';
import { approvalsOf } from '../trueforge/wire';
import type { ProposalStore } from '../edits/proposals';
import type { ReviewPort } from '../edits/review';
import {
  prepareProposals,
  type ProposeEditDeps,
} from '../mcp/tools/propose_edit';
import { MessageBuffer, messageText, toolCallFromMessage } from './messages';

export type CommandChoice = 'once' | 'session' | 'deny';

export interface TurnFlowDeps {
  client: TrueForgeClient;
  rootDir: string;
  store: ProposalStore;
  review: ReviewPort;
  proposeDeps: ProposeEditDeps;
  askCommand: (command: string) => Promise<CommandChoice>;
  onTranscript?: (event: TranscriptEvent) => void;
  onReviewComplete?: (runId: string, proposalId: string, accepted: number, rejected: number) => void;
  /** Return a deny reason to refuse a proposal before staging it. */
  proposalGate?: (turnId: string) => string | undefined;
  /** Fires for system denies (match failures, unknown calls, gated calls). */
  onDenied?: (reason: string) => void;
  isCancelled: () => boolean;
  /** Override for tests; production answers through the client. */
  answerApproval?: (
    sessionId: string,
    turnId: string,
    approval: ApprovalRequest,
    allow: boolean,
    reason?: string,
  ) => Promise<void>;
}

/**
 * Shared turn-event handler for inline edit and agent mode. Buffers
 * model.message events, resolves approval pauses to tool name plus
 * arguments, and drives the propose_edit review and run_command prompt.
 * The run id is the turn id: undo groups per turn.
 */
export function createTurnHandler(deps: TurnFlowDeps): TurnEventCallback {
  const messages = new MessageBuffer();
  const sessionCommands = new Set<string>();
  let proposalCounter = 0;
  const answer = deps.answerApproval ?? deps.client.answerApproval.bind(deps.client);

  return async (event, cursor, info) => {
    if (event.type === 'model.message' || event.type === 'model.message.delta') {
      messages.feed(event);
      deps.onTranscript?.({
        kind: 'text',
        text: messageText(event),
        id: event.id,
        delta: event.type === 'model.message.delta',
      });
    }
    if (event.type === 'tool.response') {
      deps.onTranscript?.({ kind: 'tool_result', text: 'tool finished' });
    }
    for (const approval of approvalsOf(event)) {
      if (deps.isCancelled()) {
        return;
      }
      const source = messages.get(approval.sourceEventId);
      const call = source ? toolCallFromMessage(source, approval.toolCallId) : undefined;
      if (!call) {
        deps.onDenied?.('Unknown tool call.');
        await answer(info.sessionId, cursor.turnId, approval, false, 'Unknown tool call.');
        continue;
      }
      deps.onTranscript?.({ kind: 'tool_call', text: call.name, tool: call.name });
      if (call.name === 'propose_edit') {
        await handleProposeEdit(deps, answer, info.sessionId, cursor.turnId, approval, call.args, () => {
          proposalCounter += 1;
          return `p${proposalCounter}`;
        });
      } else if (call.name === 'run_command') {
        await handleRunCommand(deps, answer, info.sessionId, cursor.turnId, approval, call.args, sessionCommands);
      } else {
        await answer(info.sessionId, cursor.turnId, approval, false, `Unknown tool ${call.name}.`);
      }
    }
  };
}

async function handleProposeEdit(
  deps: TurnFlowDeps,
  answer: NonNullable<TurnFlowDeps['answerApproval']>,
  sessionId: string,
  turnId: string,
  approval: ApprovalRequest,
  args: Record<string, unknown>,
  nextId: () => string,
): Promise<void> {
  const gateReason = deps.proposalGate?.(turnId);
  if (gateReason) {
    deps.onDenied?.(gateReason);
    await answer(sessionId, turnId, approval, false, gateReason);
    return;
  }
  try {
    const staged = await prepareProposals(deps.proposeDeps, turnId, nextId, args);
    const paths = staged.map((entry) => entry.proposal.path).join(', ');
    deps.onTranscript?.({ kind: 'approval', text: `reviewing ${paths}` });
    // One combined review: every file opens, the single approval answers
    // once the user has decided everywhere.
    const results = await Promise.all(
      staged.map((entry) => {
        const started = deps.review.open(deps.rootDir, turnId, entry.proposal.id, entry.newText);
        return started.then((result) => {
          deps.onReviewComplete?.(
            turnId,
            entry.proposal.id,
            result.accepted.length,
            result.rejected.length,
          );
          return result;
        });
      }),
    );
    const accepted = results.reduce((sum, result) => sum + result.accepted.length, 0);
    await answer(
      sessionId,
      turnId,
      approval,
      accepted > 0,
      accepted > 0 ? undefined : 'User rejected every hunk.',
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.onDenied?.(reason);
    await answer(sessionId, turnId, approval, false, reason);
  }
}

async function handleRunCommand(
  deps: TurnFlowDeps,
  answer: NonNullable<TurnFlowDeps['answerApproval']>,
  sessionId: string,
  turnId: string,
  approval: ApprovalRequest,
  args: Record<string, unknown>,
  sessionCommands: Set<string>,
): Promise<void> {
  const command = typeof args['command'] === 'string' ? args['command'] : '';
  if (command && sessionCommands.has(command)) {
    await answer(sessionId, turnId, approval, true);
    return;
  }
  deps.onTranscript?.({ kind: 'approval', text: `command: ${command}` });
  const choice = await deps.askCommand(command);
  if (choice === 'session' && command) {
    sessionCommands.add(command);
  }
  await answer(
    sessionId,
    turnId,
    approval,
    choice !== 'deny',
    choice === 'deny' ? 'User denied this command.' : undefined,
  );
}
