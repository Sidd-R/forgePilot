import type { WireEvent } from '../trueforge/wire';

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  /** Model calls that reported usage. */
  calls: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cached: 0, calls: 0 };

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Sums token usage across a run. TrueForge reports usage per model call
 * on the message (or its final delta); keyed by message id, the latest
 * report wins so repeated reports never double count.
 */
export class UsageMeter {
  private readonly byMessage = new Map<string, TokenUsage>();

  /** Feed any event; returns true when the totals changed. */
  feed(event: WireEvent): boolean {
    if (event.type !== 'model.message' && event.type !== 'model.message.delta') {
      return false;
    }
    const usage = event['usage'];
    if (typeof usage !== 'object' || usage === null) {
      return false;
    }
    const raw = usage as Record<string, unknown>;
    this.byMessage.set(event.id, {
      input: num(raw['input_tokens']),
      output: num(raw['output_tokens']),
      cached: num(raw['cache_read_tokens']),
      calls: 1,
    });
    return true;
  }

  total(): TokenUsage {
    return addUsage(ZERO_USAGE, ...this.byMessage.values());
  }
}

export function addUsage(...parts: TokenUsage[]): TokenUsage {
  return parts.reduce(
    (sum, part) => ({
      input: sum.input + part.input,
      output: sum.output + part.output,
      cached: sum.cached + part.cached,
      calls: sum.calls + part.calls,
    }),
    { ...ZERO_USAGE },
  );
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

/** "12.4k in · 318 out" (plus cached when the provider reports it). */
export function formatUsage(usage: TokenUsage): string {
  const cached = usage.cached > 0 ? ` (${compactTokens(usage.cached)} cached)` : '';
  return `${compactTokens(usage.input)} in${cached} · ${compactTokens(usage.output)} out`;
}
