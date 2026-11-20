import type { WireEvent } from '../trueforge/wire';

export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
}

/** Extract the tool name and parsed arguments from a model.message event. */
export function toolCallFromMessage(
  event: WireEvent,
  toolCallId: string,
): ToolCallInfo | undefined {
  const found = (event.tool_calls ?? []).find((call) => call.id === toolCallId);
  const name = found?.function?.name;
  if (!found || !name) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(found.function?.arguments ?? '{}');
    return {
      name,
      args:
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {},
    };
  } catch {
    return undefined;
  }
}

interface WireToolCallFull {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
  [key: string]: unknown;
}

function mergeToolCalls(base: WireToolCallFull[], frag: WireToolCallFull[]): WireToolCallFull[] {
  const out = base.map((call) => ({
    ...call,
    function: { ...(call.function ?? {}) },
  }));
  for (const piece of frag) {
    const at = out.findIndex(
      (call) =>
        (piece.id !== undefined && call.id === piece.id) ||
        (piece.id === undefined && piece.index !== undefined && call.index === piece.index),
    );
    if (at === -1) {
      out.push({ ...piece, function: { ...(piece.function ?? {}) } });
      continue;
    }
    const target = out[at];
    for (const [key, value] of Object.entries(piece)) {
      if (key === 'function' && typeof value === 'object' && value !== null) {
        const fn = value as { name?: string; arguments?: string };
        target.function = {
          name: fn.name ?? target.function?.name,
          arguments: `${target.function?.arguments ?? ''}${fn.arguments ?? ''}`,
        };
      } else if (value !== undefined) {
        (target as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}

/**
 * Merge a model.message.delta into its base message (same id): content
 * fragments concatenate, tool calls merge by id with arguments
 * concatenated, and finish_reason/usage take the last value.
 */
export function mergeDelta(base: WireEvent, delta: WireEvent): WireEvent {
  const out: WireEvent = { ...base };
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'type' || key === 'id' || key === 'thread_id' || key === 'created_at') {
      continue;
    }
    if (key === 'content' && typeof value === 'string') {
      const prev = typeof out['content'] === 'string' ? (out['content'] as string) : '';
      out['content'] = prev + value;
    } else if (key === 'tool_calls' && Array.isArray(value)) {
      out.tool_calls = mergeToolCalls(
        (out.tool_calls ?? []) as WireToolCallFull[],
        value as WireToolCallFull[],
      ) as WireEvent['tool_calls'];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Assembles streamed messages from base events plus their deltas. */
export class MessageBuffer {
  private messages = new Map<string, WireEvent>();

  feed(event: WireEvent): void {
    if (event.type === 'model.message') {
      this.messages.set(event.id, { ...event });
    } else if (event.type === 'model.message.delta') {
      const base = this.messages.get(event.id) ?? { type: 'model.message', id: event.id };
      this.messages.set(event.id, mergeDelta(base, event));
    }
  }

  get(id: string): WireEvent | undefined {
    return this.messages.get(id);
  }

  /** Find a tool call by id across every assembled message. */
  findCall(toolCallId: string): ToolCallInfo | undefined {
    for (const message of this.messages.values()) {
      const call = toolCallFromMessage(message, toolCallId);
      if (call) {
        return call;
      }
    }
    return undefined;
  }

  /** Assembled texts in arrival order. */
  texts(): string[] {
    return [...this.messages.values()].map(messageText).filter((text) => text.length > 0);
  }
}

/** Plain text out of model.message content (string or parts array). */
export function messageText(event: WireEvent): string {
  const content = event['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return '';
      })
      .join('');
  }
  const delta = event['delta'];
  if (typeof delta === 'string') {
    return delta;
  }
  if (typeof delta === 'object' && delta !== null && 'text' in delta) {
    return String((delta as { text: unknown }).text);
  }
  return '';
}
