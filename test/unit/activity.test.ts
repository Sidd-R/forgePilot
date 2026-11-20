import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeActivity } from '../../src/inline/activity';

describe('describeActivity', () => {
  it('quotes streamed narration on one line, keeping the latest words', () => {
    const text = 'Fixing the docstring\nto list the false values.';
    assert.equal(describeActivity({ type: 'model.message', id: 'm', content: text }), '“Fixing the docstring to list the false values.”');
    const long = describeActivity({ type: 'model.message', id: 'm', content: 'x'.repeat(200) + ' end' });
    assert.ok(long?.startsWith('“…') && long.endsWith('end”'));
  });

  it('reports a tool call being written with its size', () => {
    const msg = {
      type: 'model.message',
      id: 'm',
      content: 'Plan',
      tool_calls: [{ id: 'c', function: { name: 'propose_edit', arguments: '{"path":"a"}' } }],
    };
    assert.equal(describeActivity(msg), 'Writing the edit… (12 chars)');
  });

  it('summarises fenced code instead of quoting it, and ignores empty messages', () => {
    assert.equal(
      describeActivity({ type: 'model.message', id: 'm', content: '```python\ndef f(): pass' }),
      'Writing the replacement code… (23 chars)',
    );
    assert.equal(describeActivity({ type: 'model.message', id: 'm', content: '' }), undefined);
    assert.equal(describeActivity(undefined), undefined);
  });
});
