import type { WireEvent } from './wire';

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

/** Yield wire events from a TrueForge SSE response. */
export async function* readSse(res: Response): AsyncGenerator<WireEvent> {
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
