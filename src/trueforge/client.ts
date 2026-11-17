/**
 * TrueForge HTTP client. Uses the REST + SSE API directly: the published
 * TypeScript SDK cannot load under Node's CommonJS resolver (its package
 * ships `type: module` with `.js` CommonJS files), and the eligibility gate
 * explicitly allows the HTTP API.
 */
import { readSse } from './sse';
import type {
  ApprovalRequest,
  StreamCursor,
  TurnEventCallback,
  TurnTerminal,
  WireAgentSpec,
} from './wire';

/** HTTP failure with status for retry classification. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`TrueForge ${method} ${path} failed (${status}): ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
}

/**
 * Thin wrapper over TrueForge sessions, streamed turns, approval answers,
 * and cancellation. Retry/fallback policy lives in resilience.ts.
 */
export class TrueForgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 300_000,
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      throw new Error(
        `TrueForge ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(method, path, res.status, text);
    }
    return res;
  }

  /** Fail fast with a readable message when TrueForge is unreachable. */
  async preflight(): Promise<void> {
    try {
      await this.request('GET', '/api/v1/models');
    } catch {
      throw new Error(
        `TrueForge is not running at ${this.baseUrl}. ` +
          'Start it with npx @truefoundry/trueforge@latest.',
      );
    }
  }

  async createSession(spec: WireAgentSpec): Promise<string> {
    const res = await this.request('POST', '/api/v1/sessions', {
      agent: { spec },
    });
    const data = (await res.json()) as { data: { id: string } };
    return data.data.id;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request('POST', `/api/v1/sessions/${sessionId}/cancel`, {});
  }

  async answerApproval(
    sessionId: string,
    turnId: string,
    approval: ApprovalRequest,
    allow: boolean,
    reason?: string,
  ): Promise<void> {
    await this.request(
      'POST',
      `/api/v1/sessions/${sessionId}/turns/${turnId}/events`,
      {
        events: [
          {
            type: 'user.tool_approval',
            approval: allow
              ? { status: 'allow' }
              : { status: 'deny', reason: reason ?? 'rejected' },
            thread_id: approval.threadId,
            tool_call_id: approval.toolCallId,
          },
        ],
      },
    );
  }

  /**
   * Stream a turn to its terminal state. When the HTTP stream ends while
   * the turn is still alive (e.g. after an approval pause), resubscribe
   * from the last seen event id and keep reading.
   */
  async streamTurn(
    sessionId: string,
    input: string,
    onEvent: TurnEventCallback,
    opts?: StreamOptions,
  ): Promise<TurnTerminal> {
    const cursor: StreamCursor = { turnId: '', lastEventId: '' };
    let res = await this.request(
      'POST',
      `/api/v1/sessions/${sessionId}/turns`,
      {
        input: [{ type: 'user.message', content: input }],
        stream: true,
      },
      opts?.signal,
    );
    let resubscribed = 0;

    for (;;) {
      for await (const event of readSse(res)) {
        cursor.lastEventId = event.id;
        if (event.type === 'turn.created' && event.turn_id) {
          cursor.turnId = event.turn_id;
        }
        await onEvent(event, cursor);
        if (event.type === 'turn.done' && event.state) {
          return {
            status: event.state.status,
            message: event.state.message ?? undefined,
          };
        }
      }
      if (opts?.signal?.aborted) {
        throw new Error('Turn stream aborted.');
      }
      // Stream ended without turn.done: the turn is paused or the
      // connection dropped. Resubscribe a bounded number of times.
      resubscribed += 1;
      if (!cursor.turnId || resubscribed > 5) {
        throw new Error('Turn stream ended before turn.done arrived.');
      }
      res = await this.request(
        'GET',
        `/api/v1/sessions/${sessionId}/turns/${cursor.turnId}/subscribe` +
          `?after_event_id=${encodeURIComponent(cursor.lastEventId)}`,
        undefined,
        opts?.signal,
      );
    }
  }
}
