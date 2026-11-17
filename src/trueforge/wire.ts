/** TrueForge wire shapes (snake_case REST + SSE). No logic except approvalsOf. */

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
