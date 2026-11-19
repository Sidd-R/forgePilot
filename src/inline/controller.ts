import type { TranscriptEvent } from '../types';
import type { TrueForgeClient } from '../trueforge/client';
import {
  ExhaustedError,
  TurnCancelledError,
  runTurnResilient,
  type TurnDeps,
} from '../trueforge/resilience';
import type { TurnEventCallback, WireAgentSpec } from '../trueforge/wire';
import type { ProposalStore } from '../edits/proposals';
import { createProposal, hashArgs } from '../edits/proposals';
import type { ReviewPort } from '../edits/review';
import type { DiagnosticItem } from '../mcp/tools/get_diagnostics';
import {
  applyDecidedProposal,
  type ProposeEditDeps,
} from '../mcp/tools/propose_edit';
import { createTurnHandler, type CommandChoice } from '../flows/turns';
import { MessageBuffer } from '../flows/messages';
import { parseFencedBlock } from './fenced';

export interface InlineTarget {
  rootDir: string;
  relPath: string;
  /** 1-based selection bounds. */
  startLine: number;
  endLine: number;
  selectedText: string;
  /** ~40 lines each side, read-only context. */
  beforeText: string;
  afterText: string;
}

/** Prompt for one inline turn: instruction plus the selection in context. */
export function buildInlineInput(target: InlineTarget, instruction: string): string {
  return [
    `Instruction: ${instruction}`,
    `File: ${target.relPath}`,
    `Selected lines ${target.startLine}-${target.endLine} (edit ONLY this range):`,
    '```',
    target.selectedText,
    '```',
    'Read-only context before (do not include in your replacement):',
    '```',
    target.beforeText,
    '```',
    'Read-only context after (do not include in your replacement):',
    '```',
    target.afterText,
    '```',
    'Send one edit per changed location so each can be reviewed separately.',
  ].join('\n');
}

export type InlineOutcome = 'applied' | 'rejected' | 'cancelled' | 'failed';

function errorKey(error: DiagnosticItem): string {
  return `${error.line}:${error.message}`;
}

/** Errors present now that were not present before the edit. */
export function selectNewErrors(
  before: DiagnosticItem[],
  after: DiagnosticItem[],
): DiagnosticItem[] {
  const known = new Set(before.filter((d) => d.severity === 'error').map(errorKey));
  return after.filter((d) => d.severity === 'error' && !known.has(errorKey(d)));
}

export interface InlineDeps {
  client: TrueForgeClient;
  spec: WireAgentSpec;
  models: string[];
  target: InlineTarget;
  instruction: string;
  store: ProposalStore;
  review: ReviewPort;
  proposeDeps: ProposeEditDeps;
  /** Current full file text, for the fenced path and staleness checks. */
  readFullText: () => Promise<string | null>;
  diagnostics: (relPath: string) => DiagnosticItem[];
  onNotice: (message: string) => void;
  onTranscript?: (event: TranscriptEvent) => void;
  onSession?: (sessionId: string) => void;
  onReviewComplete?: (runId: string, proposalId: string) => void;
  isCancelled: () => boolean;
  fixLimit?: number;
}

interface TurnMemory {
  buffer: MessageBuffer;
}

/**
 * Inline edit: one resilient turn against the lean inline agent. The
 * result arrives as a propose_edit approval (reviewed in-editor) or, for
 * weak tool-calling models, as a fenced block applied to the selection.
 * Diagnostics errors feed back for up to `fixLimit` repair turns.
 */
export async function runInlineEdit(deps: InlineDeps): Promise<InlineOutcome> {
  const memory: TurnMemory = { buffer: new MessageBuffer() };
  let acceptedHunks = 0;
  let reviewsOpened = 0;
  let lastDeny = '';
  const reviewedTurns = new Set<string>();
  const diagnosticsBefore = deps.diagnostics(deps.target.relPath);
  // Count reviews (not approvals): denied-before-staging calls must not
  // block the fenced fallback below.
  const review: ReviewPort = {
    open: (rootDir, runId, proposalId, newText) => {
      reviewsOpened += 1;
      return deps.review.open(rootDir, runId, proposalId, newText);
    },
  };
  const shared = createTurnHandler({
    client: deps.client,
    rootDir: deps.target.rootDir,
    store: deps.store,
    review,
    proposeDeps: deps.proposeDeps,
    askCommand: (_command: string): Promise<CommandChoice> => Promise.resolve('deny'),
    onTranscript: deps.onTranscript,
    onReviewComplete: (runId, proposalId, accepted) => {
      acceptedHunks += accepted;
      reviewedTurns.add(runId);
      deps.onReviewComplete?.(runId, proposalId);
    },
    proposalGate: (turnId) =>
      reviewedTurns.has(turnId)
        ? 'Inline edit reviews one proposal per turn; ignoring this extra call.'
        : undefined,
    onDenied: (reason) => {
      lastDeny = reason;
    },
    isCancelled: deps.isCancelled,
  });
  const onEvent: TurnEventCallback = (event, cursor, info) => {
    memory.buffer.feed(event);
    return shared(event, cursor, info);
  };
  const turnDeps: TurnDeps = {
    createSession: (spec) => deps.client.createSession(spec),
    streamTurn: (sessionId, input, handler, opts) =>
      deps.client.streamTurn(sessionId, input, handler, opts),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  let sessionId: string;
  try {
    const result = await runTurnResilient(turnDeps, {
      spec: deps.spec,
      input: buildInlineInput(deps.target, deps.instruction),
      models: deps.models,
      onEvent,
      onNotice: deps.onNotice,
      onSession: deps.onSession,
      isCancelled: deps.isCancelled,
    });
    sessionId = result.sessionId;
    if (result.terminal.status === 'cancelled' || deps.isCancelled()) {
      return 'cancelled';
    }
  } catch (err) {
    if (err instanceof TurnCancelledError || deps.isCancelled()) {
      return 'cancelled';
    }
    if (!(err instanceof ExhaustedError)) {
      throw err;
    }
    deps.onNotice(`Inline edit failed: ${err.lastMessage}`);
    return 'failed';
  }

  if (reviewsOpened === 0) {
    const outcome = await runFencedFallback(deps, memory, sessionId, lastDeny);
    if (outcome !== 'applied') {
      return outcome;
    }
  } else if (acceptedHunks === 0) {
    return 'rejected';
  }

  // Diagnostics-driven repair for errors this run introduced, same
  // session, bounded. Pre-existing errors never trigger another round.
  const fixLimit = deps.fixLimit ?? 2;
  for (let fix = 0; fix < fixLimit; fix++) {
    if (deps.isCancelled()) {
      return 'cancelled';
    }
    const errors = selectNewErrors(
      diagnosticsBefore,
      deps.diagnostics(deps.target.relPath),
    );
    if (errors.length === 0) {
      return 'applied';
    }
    const prompt =
      `Your edit to ${deps.target.relPath} introduced these errors:\n` +
      errors
        .slice(0, 10)
        .map((d) => `line ${d.line}: ${d.message}`)
        .join('\n') +
      '\nFix them with propose_edit (same file, smallest change).';
    memory.buffer = new MessageBuffer();
    const reviewsBefore = reviewsOpened;
    try {
      const terminal = await deps.client.streamTurn(sessionId, prompt, onEvent);
      if (terminal.status === 'cancelled') {
        return 'cancelled';
      }
      if (terminal.status !== 'done' || reviewsOpened === reviewsBefore) {
        return 'applied';
      }
    } catch (err) {
      deps.onNotice(`Repair turn failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'applied';
    }
  }
  return 'applied';
}

/** Fenced-block path: replace the selection, review, apply. */
async function runFencedFallback(
  deps: InlineDeps,
  memory: TurnMemory,
  sessionId: string,
  lastDeny: string,
): Promise<InlineOutcome> {
  const texts = memory.buffer.texts();
  const reply = texts[texts.length - 1] ?? '';
  const replacement = parseFencedBlock(reply);
  if (!replacement) {
    deps.onNotice(
      lastDeny
        ? `No suggestion produced: ${lastDeny.slice(0, 220)}`
        : 'The model returned no edit (no tool call, no code block).',
    );
    return 'failed';
  }
  const full = await deps.readFullText();
  if (full === null) {
    deps.onNotice('The file is gone; discarding the proposal.');
    return 'failed';
  }
  const lines = full.split('\n');
  const currentSelection = lines.slice(deps.target.startLine - 1, deps.target.endLine).join('\n');
  // Ignore trailing newlines: selecting to the next line start is the same range.
  if (currentSelection.replace(/\n+$/, '') !== deps.target.selectedText.replace(/\n+$/, '')) {
    deps.onNotice('The selection changed while the model was working; discarding the proposal.');
    return 'failed';
  }
  const newFull = [
    ...lines.slice(0, deps.target.startLine - 1),
    replacement,
    ...lines.slice(deps.target.endLine),
  ].join('\n');
  const runId = `inline-${sessionId.slice(0, 8)}`;
  const { proposal } = createProposal(
    'p1',
    deps.target.relPath,
    full,
    { content: newFull },
    hashArgs({ path: deps.target.relPath, fenced: replacement }),
  );
  if (proposal.hunks.length === 0) {
    deps.onNotice('The model proposed no changes.');
    return 'rejected';
  }
  deps.store.addProposal(runId, proposal, full);
  deps.onReviewComplete?.(runId, 'p1');
  const result = await deps.review.open(deps.target.rootDir, runId, 'p1', newFull);
  if (result.accepted.length === 0) {
    return 'rejected';
  }
  await applyDecidedProposal(deps.proposeDeps, runId, 'p1');
  return 'applied';
}
