import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeTool,
  formatElapsed,
  groupPack,
  noticeLevel,
  sessionUrl,
  summarizeChanges,
} from '../../src/panel/present';

describe('describeTool', () => {
  it('summarises file reads with line ranges', () => {
    assert.equal(
      describeTool('read_file', { path: 'src/a.py', start_line: 3, end_line: 9 }).detail,
      'src/a.py:3-9',
    );
    assert.equal(describeTool('read_file', { path: 'src/a.py' }).detail, 'src/a.py');
  });

  it('quotes search queries and regex patterns', () => {
    assert.equal(describeTool('search_code', { query: 'cli command' }).detail, '"cli command"');
    assert.equal(describeTool('find_text', { pattern: 'def \\w+' }).detail, '"def \\w+"');
  });

  it('lists every file of a batched propose_edit', () => {
    const label = describeTool('propose_edit', {
      files: [{ path: 'a.py' }, { path: 'b.rst' }],
    });
    assert.equal(label.detail, 'a.py, b.rst');
  });

  it('truncates long details and tolerates unknown tools', () => {
    const long = describeTool('run_command', { command: 'x'.repeat(300) });
    assert.ok(long.detail.length <= 118);
    assert.equal(describeTool('mystery', {}).label, 'mystery');
  });
});

describe('noticeLevel', () => {
  it('flags fallback as a warning, failures as errors', () => {
    assert.equal(
      noticeLevel('Primary model failed (401). Continuing with muse/backup.'),
      'warn',
    );
    assert.equal(noticeLevel('TrueForge is not running at http://x'), 'error');
    assert.equal(noticeLevel('Run cancelled.'), 'info');
  });
});

describe('groupPack', () => {
  it('groups by file in rank order, summing tokens and deduping reasons', () => {
    const files = groupPack([
      { path: 'cli.py', startLine: 1, endLine: 9, reason: 'matched cli', tokens: 10 },
      { path: 'test_cli.py', startLine: 1, endLine: 4, reason: 'test partner', tokens: 5 },
      { path: 'cli.py', startLine: 20, endLine: 30, reason: 'matched cli', tokens: 7 },
    ]);
    assert.deepEqual(files.map((f) => f.path), ['cli.py', 'test_cli.py']);
    assert.equal(files[0].tokens, 17);
    assert.deepEqual(files[0].reasons, ['matched cli']);
    assert.equal(files[0].ranges.length, 2);
  });
});

describe('formatting', () => {
  it('formats elapsed time and session links', () => {
    assert.equal(formatElapsed(65_400), '1:05');
    assert.equal(formatElapsed(-5), '0:00');
    assert.equal(sessionUrl('http://localhost:8790/', 'abc'), 'http://localhost:8790/sessions/abc');
  });
});

describe('summarizeChanges', () => {
  it('merges repeated reviews per file and lists changed files first', () => {
    const files = summarizeChanges([
      { path: 'docs/cli.rst', accepted: 0, rejected: 1, line: 1 },
      { path: 'src/cli.py', accepted: 2, rejected: 0, line: 590 },
      { path: 'docs/cli.rst', accepted: 1, rejected: 0, line: 300 },
      { path: 'tests/test_cli.py', accepted: 0, rejected: 2, line: 1 },
    ]);
    assert.deepEqual(files, [
      { path: 'docs/cli.rst', accepted: 1, rejected: 1, line: 300 },
      { path: 'src/cli.py', accepted: 2, rejected: 0, line: 590 },
      { path: 'tests/test_cli.py', accepted: 0, rejected: 2, line: 1 },
    ]);
  });
});
