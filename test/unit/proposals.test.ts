import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProposalStore,
  createProposal,
  hashArgs,
} from '../../src/edits/proposals';
import { MatchError, applyEditsToText } from '../../src/edits/matcher';

describe('applyEditsToText', () => {
  it('replaces matches in order', () => {
    const out = applyEditsToText('a1\nb2\nc3\n', [
      { old_text: 'a1', new_text: 'A1' },
      { old_text: 'c3', new_text: 'C3' },
    ]);
    assert.equal(out, 'A1\nb2\nC3\n');
  });

  it('throws a readable error for bad old_text', () => {
    assert.throws(
      () => applyEditsToText('aaa\n', [{ old_text: 'zzz', new_text: 'q' }]),
      MatchError,
    );
  });
});

describe('createProposal', () => {
  it('builds two hunks for a docstring plus code change', () => {
    const oldText =
      'def get_debug_flag(default=None):\n' +
      '    """Get the debug flag."""\n' +
      '\n' +
      '    import os as _os\n' +
      '\n' +
      '    val = _os.getenv("FLASK_DEBUG")\n' +
      '    if not val:\n' +
      '        return default\n' +
      '    return val == "1"\n';
    const { proposal, newText } = createProposal(
      'p1',
      'src/flask/helpers.py',
      oldText,
      {
        edits: [
          {
            old_text: '    """Get the debug flag."""',
            new_text: '    """Get the debug flag. False values: 0, f, n, off."""',
          },
          {
            old_text: '    return val == "1"',
            new_text: '    return val.lower() not in ("0", "f", "n", "off")',
          },
        ],
      },
      'hash',
    );
    assert.equal(proposal.hunks.length, 2);
    assert.match(newText, /False values/);
    assert.match(newText, /not in/);
  });

  it('treats content for new files as a single hunk', () => {
    const { proposal } = createProposal('p2', 'new.py', null, { content: 'x = 1\n' }, 'h');
    assert.equal(proposal.isNewFile, true);
    assert.equal(proposal.hunks.length, 1);
    assert.equal(proposal.hunks[0].id, 'h1');
  });

  it('requires content for new files', () => {
    assert.throws(() =>
      createProposal('p3', 'new.py', null, { edits: [] }, 'h'),
    );
  });
});

describe('hashArgs', () => {
  it('is stable and sensitive', () => {
    assert.equal(hashArgs({ a: 1 }), hashArgs({ a: 1 }));
    assert.notEqual(hashArgs({ a: 1 }), hashArgs({ a: 2 }));
  });
});

describe('ProposalStore', () => {
  it('keeps the first checkpoint per file', () => {
    const store = new ProposalStore();
    store.ensureCheckpoint('r1', 'a.py', 'v0');
    store.ensureCheckpoint('r1', 'a.py', 'v1');
    const restores = store.undoRun('r1');
    assert.deepEqual(restores, [{ path: 'a.py', text: 'v0' }]);
  });

  it('undoLast restores the pre-proposal text', () => {
    const store = new ProposalStore();
    const { proposal } = createProposal('p1', 'a.py', 'v0\n', { content: 'v1\n' }, 'h');
    store.addProposal('r1', proposal, 'v0\n');
    store.decide('r1', 'p1', 'h1', 'accepted');
    assert.deepEqual(store.undoLast('r1'), [{ path: 'a.py', text: 'v0\n' }]);
    assert.deepEqual(store.undoLast('r1'), []);
  });

  it('undoRun deletes created files and restores the rest', () => {
    const store = new ProposalStore();
    const { proposal } = createProposal('p1', 'new.py', null, { content: 'x\n' }, 'h');
    store.addProposal('r1', proposal, null);
    store.ensureCheckpoint('r1', 'old.py', 'orig\n');
    const restores = store.undoRun('r1');
    assert.deepEqual(restores, [
      { path: 'new.py', text: null },
      { path: 'old.py', text: 'orig\n' },
    ]);
  });

  it('acceptedText keeps rejected hunks original', () => {
    const store = new ProposalStore();
    const oldText = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
    const { proposal } = createProposal(
      'p1',
      'a.py',
      oldText,
      {
        edits: [
          { old_text: 'l2', new_text: 'L2' },
          { old_text: 'l8', new_text: 'L8' },
        ],
      },
      'h',
    );
    assert.equal(proposal.hunks.length, 2);
    store.addProposal('r1', proposal, oldText);
    store.decide('r1', 'p1', proposal.hunks[0].id, 'accepted');
    store.decide('r1', 'p1', proposal.hunks[1].id, 'rejected');
    const stored = store.getProposal('r1', 'p1');
    assert.ok(stored);
    assert.equal(
      ProposalStore.acceptedText(oldText, stored),
      'l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\n',
    );
  });
});
