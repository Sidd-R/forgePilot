import { HttpError } from './client';
import type {
  TurnEventCallback,
  TurnTerminal,
  WireAgentSpec,
} from './wire';

/** Retryable failures clear on their own; the rest skip to the next model. */
export type FailureKind = 'retry' | 'next-model';

/** Backoff schedule: about 1s, then 3s. */
export const RETRY_DELAYS_MS = [1000, 3000];

const NEXT_MODEL_PATTERNS = [
  /invalid api key/i,
  /unauthorized|unauthenticated/i,
  /unknown model/i,
  /model.*not found/i,
  /connection refused/i,
  /econnrefused/i,
  /no such model/i,
];

const RETRY_PATTERNS = [
  /timed? ?out/i,
  /\b429\b/,
  /\b5\d\d\b/,
  /rate limit/i,
  /overloaded/i,
  /try again/i,
  /temporarily unavailable/i,
  /stream ended/i,
  /aborted/i,
  /silence/i,
];

/** Classify a failure from its HTTP status and message. */
export function classifyFailure(status: number | undefined, message: string): FailureKind {
  if (status === 429 || (status !== undefined && status >= 500) || status === 408) {
    return 'retry';
  }
  if (status === 401 || status === 403) {
    return 'next-model';
  }
  for (const pattern of NEXT_MODEL_PATTERNS) {
    if (pattern.test(message)) {
      return 'next-model';
    }
  }
  for (const pattern of RETRY_PATTERNS) {
    if (pattern.test(message)) {
      return 'retry';
    }
  }
  // Unknown failures still reach the fallback after the retry budget.
  return status === undefined || status >= 500 ? 'retry' : 'next-model';
}

/** All models exhausted. Carries the last failure for display. */
export class ExhaustedError extends Error {
  readonly lastMessage: string;

  constructor(lastMessage: string) {
    super(
      `All models failed. Last error: ${lastMessage} ` +
        'Check TrueForge model settings.',
    );
    this.name = 'ExhaustedError';
    this.lastMessage = lastMessage;
  }
}

export interface TurnDeps {
  createSession: (spec: WireAgentSpec) => Promise<string>;
  streamTurn: (
    sessionId: string,
    input: string,
    onEvent: TurnEventCallback,
    opts?: { signal?: AbortSignal },
  ) => Promise<TurnTerminal>;
  sleep: (ms: number) => Promise<void>;
}

export interface ResilientTurnOptions {
  /** Base spec; the model name is replaced per attempt. */
  spec: WireAgentSpec;
  input: string;
  /** [primary, ...fallbacks]. */
  models: string[];
  onEvent: TurnEventCallback;
  onNotice: (message: string) => void;
  onSession?: (sessionId: string) => void;
  silenceTimeoutMs?: number;
}

export interface ResilientTurnResult {
  terminal: TurnTerminal;
  model: string;
  sessionId: string;
}

function failureOf(err: unknown): { status: number | undefined; message: string } {
  if (err instanceof HttpError) {
    return { status: err.status, message: `${err.message} ${err.body}`.slice(0, 500) };
  }
  return { status: undefined, message: err instanceof Error ? err.message : String(err) };
}

/**
 * Run one turn with retry-then-fallback: retryable failures retry twice
 * per model (1s, 3s), auth/unknown-model/connection failures skip to the
 * next model immediately, and 45s of stream silence counts as a timeout.
 * Nothing here touches files: no proposal exists until a model answers.
 */
export async function runTurnResilient(
  deps: TurnDeps,
  opts: ResilientTurnOptions,
): Promise<ResilientTurnResult> {
  if (opts.models.length === 0) {
    throw new ExhaustedError('no models configured');
  }
  const silenceMs = opts.silenceTimeoutMs ?? 45_000;
  let lastMessage = '';

  for (let mi = 0; mi < opts.models.length; mi++) {
    const model = opts.models[mi];
    const spec: WireAgentSpec = { ...opts.spec, model: { name: model } };

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const retryLeft = attempt < RETRY_DELAYS_MS.length;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('stream silence timeout')),
        silenceMs,
      );
      try {
        // Fresh session per attempt: cheap, and never inherits a poisoned one.
        const sessionId = await deps.createSession(spec);
        opts.onSession?.(sessionId);
        const terminal = await deps.streamTurn(
          sessionId,
          opts.input,
          (event, cursor, info) => {
            timer.refresh();
            return opts.onEvent(event, cursor, info);
          },
          { signal: controller.signal },
        );
        clearTimeout(timer);
        if (terminal.status === 'done' || terminal.status === 'cancelled') {
          return { terminal, model, sessionId };
        }
        lastMessage = terminal.message ?? `turn ${terminal.status}`;
        if (classifyFailure(undefined, lastMessage) === 'retry' && retryLeft) {
          await deps.sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
      } catch (err) {
        clearTimeout(timer);
        const failure = failureOf(err);
        lastMessage = failure.message;
        if (classifyFailure(failure.status, failure.message) === 'retry' && retryLeft) {
          await deps.sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
      }
      break;
    }

    if (mi + 1 < opts.models.length) {
      opts.onNotice(
        `Primary model failed (${lastMessage.slice(0, 160)}). Continuing with ${opts.models[mi + 1]}.`,
      );
    }
  }
  throw new ExhaustedError(lastMessage || 'unknown failure');
}
