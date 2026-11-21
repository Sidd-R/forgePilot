import type { TranscriptEvent } from '../types';
import type { WireEvent } from '../trueforge/wire';

/** True for events from a subagent thread (anything but the main thread). */
export function isSubagentThread(event: WireEvent): boolean {
  return typeof event.thread_id === 'string' && event.thread_id !== '' && event.thread_id !== 'main';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function firstLine(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

/**
 * Transcript lines for subagent lifecycle events: a "started" row with
 * its task, and a result card carrying the subagent's final answer.
 * `names` remembers thread id -> subagent name between the two.
 */
export function subagentTranscript(
  event: WireEvent,
  names: Map<string, string>,
): TranscriptEvent | undefined {
  const thread = event.thread_id ?? '';
  if (event.type === 'thread.created' && isSubagentThread(event)) {
    const info = record(event['agent_info']);
    const name = typeof info['name'] === 'string' ? info['name'] : 'subagent';
    names.set(thread, name);
    const task = typeof info['input'] === 'string' ? firstLine(info['input']) : '';
    return { kind: 'subagent', tool: name, text: task };
  }
  if (event.type === 'thread.done' && isSubagentThread(event)) {
    const state = record(event['state']);
    const output = record(state['output']);
    const summary = typeof output['content'] === 'string' ? output['content'] : '';
    const title = typeof event['title'] === 'string' ? event['title'] : undefined;
    return {
      kind: 'subagent_result',
      tool: names.get(thread) ?? title ?? 'subagent',
      text: JSON.stringify({
        status: typeof state['status'] === 'string' ? state['status'] : 'done',
        summary,
      }),
    };
  }
  return undefined;
}
