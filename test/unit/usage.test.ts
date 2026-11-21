import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UsageMeter, addUsage, compactTokens, formatUsage } from '../../src/flows/usage';

describe('UsageMeter', () => {
  it('sums usage per model call without double counting repeats', () => {
    const meter = new UsageMeter();
    assert.equal(meter.feed({ type: 'model.message.delta', id: 'm1', content: 'x' }), false);
    assert.equal(meter.feed({ type: 'tool.response', id: 'r', usage: { input_tokens: 9 } }), false);
    meter.feed({ type: 'model.message.delta', id: 'm1', usage: { input_tokens: 1692, output_tokens: 318, cache_read_tokens: 0 } });
    meter.feed({ type: 'model.message', id: 'm1', usage: { input_tokens: 1692, output_tokens: 318 } });
    meter.feed({ type: 'model.message.delta', id: 'm2', usage: { input_tokens: 2000, output_tokens: 82, cache_read_tokens: 1500 } });
    assert.deepEqual(meter.total(), { input: 3692, output: 400, cached: 1500, calls: 2 });
  });

  it('adds and formats totals compactly', () => {
    const sum = addUsage(
      { input: 12_000, output: 300, cached: 0, calls: 1 },
      { input: 400, output: 18, cached: 0, calls: 1 },
    );
    assert.equal(formatUsage(sum), '12.4k in · 318 out');
    assert.equal(formatUsage({ input: 5, output: 1, cached: 2000, calls: 1 }), '5 in (2.0k cached) · 1 out');
    assert.equal(compactTokens(2_500_000), '2.5M');
  });
});
