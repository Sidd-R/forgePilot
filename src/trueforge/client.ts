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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin wrapper over TrueForge sessions, streamed turns, approval answers,
 * and cancellation. Retry/fallback policy lives in resilience.ts.
 */
/**
 * True when `stored` holds every value of `sent`. TrueForge fills in
 * defaults (empty tool lists, memory off, ...) on save, so the stored
 * manifest is a superset of what was sent; arrays must match exactly.
 */
export function coversSpec(stored: unknown, sent: unknown): boolean {
  if (Array.isArray(sent)) {
    return (
      Array.isArray(stored) &&
      stored.length === sent.length &&
      sent.every((item, index) => coversSpec(stored[index], item))
    );
  }
  if (typeof sent === 'object' && sent !== null) {
    if (typeof stored !== 'object' || stored === null) {
      return false;
    }
    const record = stored as Record<string, unknown>;
    return Object.entries(sent).every(
      ([key, value]) => value === undefined || coversSpec(record[key], value),
    );
  }
  return stored === sent;
}

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

  /**
   * New session. With `agentName`, the registry agent of that name is
   * first brought up to date with `spec`, and the session references it,
   * so TrueForge lists the session under that agent. Otherwise (fallback
   * models, or if the registry is unavailable) the spec is sent inline.
   */
  async createSession(spec: WireAgentSpec, agentName?: string): Promise<string> {
    const agent = agentName ? await this.syncRegistryAgent(agentName, spec).catch(() => false) : false;
    const res = await this.request('POST', '/api/v1/sessions', {
      agent: agent ? { name: agentName } : { spec },
    });
    const data = (await res.json()) as { data: { id: string } };
    return data.data.id;
  }

  /** True when the registry agent now holds exactly `spec`. */
  private async syncRegistryAgent(name: string, spec: WireAgentSpec): Promise<boolean> {
    const res = await this.request('GET', '/api/v1/agents');
    const list = (await res.json()) as { data: Array<{ id: string; name: string; manifest?: unknown }> };
    const agent = list.data.find((entry) => entry.name === name);
    if (!agent) {
      return false; // Not loaded yet: "ForgePilot: Load Agent Definitions" creates it.
    }
    if (!coversSpec(agent.manifest, spec)) {
      await this.request('PUT', `/api/v1/agents/${agent.id}`, { manifest: spec });
    }
    return true;
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
    let pausedWaits = 0;
    let lastStatus: string | undefined;

    for (;;) {
      for await (const event of readSse(res)) {
        cursor.lastEventId = event.id;
        if (event.type === 'turn.created' && event.turn_id) {
          cursor.turnId = event.turn_id;
        }
        if (event.type === 'tool.approval_required') {
          lastStatus = 'paused';
        } else if (event.type === 'turn.update' && event.state) {
          lastStatus = event.state.status;
        }
        await onEvent(event, cursor, { sessionId });
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
      // A paused turn waits on the user review, which has no time bound:
      // keep resubscribing patiently instead of failing into a retry.
      if (lastStatus === 'paused' && pausedWaits < 900) {
        pausedWaits += 1;
        await sleep(2000);
      } else {
        // Dropped connection: resubscribe a bounded number of times.
        resubscribed += 1;
        if (!cursor.turnId || resubscribed > 5) {
          throw new Error('Turn stream ended before turn.done arrived.');
        }
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
