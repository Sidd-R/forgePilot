import type { WireEvent } from '../trueforge/wire';
import { messageText } from '../flows/messages';

const MAX = 90;

/** Last sentence-ish fragment of streamed narration, single line. */
function tail(text: string): string {
  const flat = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX ? `…${flat.slice(-MAX + 1)}` : flat;
}

/**
 * What the model is visibly doing, from an assembled (base + deltas)
 * model.message: writing a tool call, or its narration so far.
 */
export function describeActivity(message: WireEvent | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const call = (message.tool_calls ?? []).find((c) => c.function?.name);
  if (call?.function?.name) {
    const size = call.function.arguments?.length ?? 0;
    return call.function.name === 'propose_edit'
      ? `Writing the edit… (${size} chars)`
      : `Calling ${call.function.name}…`;
  }
  const text = messageText(message);
  if (text.trim().startsWith('```')) {
    return `Writing the replacement code… (${text.length} chars)`;
  }
  const said = tail(text);
  return said ? `“${said}”` : undefined;
}
