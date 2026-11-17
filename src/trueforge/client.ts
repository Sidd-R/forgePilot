/**
 * TrueForge HTTP client. Uses the REST + SSE API directly: the published
 * TypeScript SDK cannot load under Node's CommonJS resolver (its package
 * ships `type: module` with `.js` CommonJS files), and the eligibility gate
 * explicitly allows the HTTP API. Wire field names are snake_case.
 */

export interface WireAgentSpec {
  model: { name: string; params?: Record<string, unknown> };
  instructions?: string;
  mcp_servers?: Array<{
    name: string;
    preload?: boolean;
    preload_tools?: string[];
    enable_tools?: string[];
    require_approval_for_tools?: string[];
  }>;
  config?: Record<string, unknown>;
}

/** One streamed turn event. Only the fields ForgePilot reads are typed. */
export interface WireEvent {
  type: string;
  id: string;
  turn_id?: string;
  thread_id?: string | null;
  state?: { status: string; message?: string | null };
  tool_calls?: Array<{ id: string; source_event_id: string }>;
  [key: string]: unknown;
}

/** Terminal state of a streamed turn. */
export interface TurnTerminal {
  status: string;
  message?: string;
}

export interface ApprovalRequest {
  threadId: string;
  toolCallId: string;
  sourceEventId: string;
}

/** Mutable cursor handed to the event callback as the stream advances. */
export interface StreamCursor {
  turnId: string;
  lastEventId: string;
}

export type TurnEventCallback = (
  event: WireEvent,
  cursor: StreamCursor,
) => void | Promise<void>;

function parseSseFrame(frame: string): WireEvent[] {
  const out: WireEvent[] = [];
  for (const line of frame.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('data:')) {
      continue;
    }
    const payload = text.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    try {
      out.push(JSON.parse(payload) as WireEvent);
    } catch {
      // Ignore malformed frames; the stream stays usable.
    }
  }
  return out;
}

async function* readSse(res: Response): AsyncGenerator<WireEvent> {
  const reader = res.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let cut = buffer.indexOf('\n\n');
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      yield* parseSseFrame(frame);
      cut = buffer.indexOf('\n\n');
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim()) {
    yield* parseSseFrame(buffer);
  }
}

/**
 * Thin wrapper over TrueForge sessions, streamed turns, approval answers,
 * and cancellation. Retry/fallback policy arrives with the resilience
 * track; the spike needs the straight-line path only.
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
  ): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `TrueForge ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
      );
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
  ): Promise<TurnTerminal> {
    const cursor: StreamCursor = { turnId: '', lastEventId: '' };
    let res = await this.request(
      'POST',
      `/api/v1/sessions/${sessionId}/turns`,
      {
        input: [{ type: 'user.message', content: input }],
        stream: true,
      },
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
      );
    }
  }
}

/** Pull the pending approvals out of a pause event. */
export function approvalsOf(event: WireEvent): ApprovalRequest[] {
  if (event.type !== 'tool.approval_required') {
    return [];
  }
  return (event.tool_calls ?? []).map((call) => ({
    threadId: event.thread_id ?? 'main',
    toolCallId: call.id,
    sourceEventId: call.source_event_id,
  }));
}
