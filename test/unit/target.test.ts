import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveTargetLines } from '../../src/inline/target';

// Mirrors flask/helpers.py: get_debug_flag at 28-35 inside a module window.
const spans = [
  { startLine: 1, endLine: 27 },
  { startLine: 28, endLine: 35, symbol: 'get_debug_flag' },
  { startLine: 36, endLine: 50, symbol: 'get_load_dotenv' },
  { startLine: 60, endLine: 120, symbol: 'Config' },
  { startLine: 70, endLine: 80, symbol: 'Config.from_env' },
];
const sel = (startLine: number, endLine: number, empty = false, partial = false) => ({
  startLine,
  endLine,
  empty,
  partial,
});

describe('resolveTargetLines', () => {
  it('widens a selected function name to the whole function (Task A)', () => {
    assert.deepEqual(resolveTargetLines(sel(28, 28, false, true), spans), {
      startLine: 28,
      endLine: 35,
      expandedTo: 'get_debug_flag',
    });
  });

  it('widens a fully selected signature line', () => {
    assert.equal(resolveTargetLines(sel(28, 28), spans)?.endLine, 35);
  });

  it('keeps a full body line or a multi-line selection as selected', () => {
    assert.deepEqual(resolveTargetLines(sel(33, 33), spans), { startLine: 33, endLine: 33 });
    assert.deepEqual(resolveTargetLines(sel(29, 33), spans), { startLine: 29, endLine: 33 });
  });

  it('picks the innermost symbol for a cursor or a partial selection', () => {
    assert.equal(resolveTargetLines(sel(75, 75, true), spans)?.expandedTo, 'Config.from_env');
    assert.equal(resolveTargetLines(sel(90, 90, false, true), spans)?.expandedTo, 'Config');
  });

  it('returns nothing for a cursor outside any symbol', () => {
    assert.equal(resolveTargetLines(sel(5, 5, true), spans), undefined);
    assert.deepEqual(resolveTargetLines(sel(5, 5, false, true), spans), { startLine: 5, endLine: 5 });
  });
});
