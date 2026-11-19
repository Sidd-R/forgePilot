import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JailError, resolveInside } from '../../src/mcp/tools/jail';
import { makeReadFile } from '../../src/mcp/tools/read_file';
import { makeFindText } from '../../src/mcp/tools/find_text';
import { makeListSymbols } from '../../src/mcp/tools/list_symbols';
import { makeSearchCode } from '../../src/mcp/tools/search_code';
import { makeGetDiagnostics } from '../../src/mcp/tools/get_diagnostics';
import { CommandRunner, makeRunCommand } from '../../src/mcp/tools/run_command';
import { makeGitDiff } from '../../src/mcp/tools/git_diff';
import {
  applyPreparedProposal,
  makeProposeEdit,
  prepareProposal,
  prepareProposals,
  type ProposeEditDeps,
} from '../../src/mcp/tools/propose_edit';
import { AlreadyAppliedError } from '../../src/edits/matcher';
import { ProposalStore } from '../../src/edits/proposals';
import { CodeIndex } from '../../src/context/index';
import type { TextResult } from '../../src/mcp/server';

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fptools-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'app.py'),
    '"""App."""\n\n\ndef main():\n    print("hello")\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'big.py'),
    Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n'),
  );
});

function textOf(result: TextResult): string {
  const first = result.content[0];
  assert.equal(first.type, 'text');
  return (first as { type: 'text'; text: string }).text;
}

describe('jail', () => {
  it('resolves inside paths', () => {
    const jailed = resolveInside(root, 'src/app.py');
    assert.equal(jailed.rel, 'src/app.py');
    assert.ok(jailed.abs.startsWith(root));
  });

  it('rejects escapes and excluded dirs', () => {
    assert.throws(() => resolveInside(root, '../../etc/passwd'), JailError);
    assert.throws(() => resolveInside(root, '.git/config'), JailError);
    assert.throws(() => resolveInside(root, '.venv/lib/x.py'), JailError);
    assert.throws(() => resolveInside(root, '/etc/hosts'), JailError);
  });
});

describe('read_file', () => {
  it('numbers lines and honors ranges', async () => {
    const tool = makeReadFile(root);
    const full = textOf(await tool.handler({ path: 'src/app.py' }));
    assert.match(full, /4: def main\(\):/);
    assert.match(full, /of 6/);
    const ranged = textOf(
      await tool.handler({ path: 'src/app.py', start_line: 4, end_line: 4 }),
    );
    assert.match(ranged, /4: def main\(\):/);
    assert.doesNotMatch(ranged, /print/);
  });

  it('caps long files with a note', async () => {
    const tool = makeReadFile(root);
    const out = textOf(await tool.handler({ path: 'src/big.py' }));
    assert.match(out, /truncated to 400 lines/);
  });

  it('errors readably on missing files', async () => {
    const tool = makeReadFile(root);
    const result = await tool.handler({ path: 'src/nope.py' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /no such file/);
  });
});

describe('find_text', () => {
  it('finds regex matches with paths', async () => {
    const tool = makeFindText(root);
    const out = textOf(await tool.handler({ pattern: 'def main' }));
    assert.match(out, /src\/app\.py:4/);
  });

  it('filters by glob and lists files on empty pattern', async () => {
    const tool = makeFindText(root);
    const out = textOf(await tool.handler({ pattern: '', glob: 'big' }));
    assert.match(out, /src\/big\.py/);
    assert.doesNotMatch(out, /app\.py/);
  });

  it('rejects invalid regex', async () => {
    const tool = makeFindText(root);
    const result = await tool.handler({ pattern: '([' });
    assert.equal(result.isError, true);
  });
});

describe('list_symbols and search_code', () => {
  it('lists symbols from the index', async () => {
    const index = CodeIndex.build(root);
    const tool = makeListSymbols(root, () => index);
    const out = textOf(await tool.handler({ path: 'src/app.py' }));
    assert.match(out, /function main \(lines 4-6\)/);
  });

  it('searches ranked chunks within budget', async () => {
    const index = CodeIndex.build(root);
    const tool = makeSearchCode(() => index);
    const out = textOf(await tool.handler({ query: 'main hello', max_tokens: 500 }));
    assert.match(out, /src\/app\.py/);
    assert.match(out, /score /);
  });
});

describe('get_diagnostics', () => {
  it('formats provider items', async () => {
    const tool = makeGetDiagnostics(() => [
      { path: 'a.py', line: 3, severity: 'error', message: 'boom' },
    ]);
    const out = textOf(await tool.handler({ path: 'a.py' }));
    assert.equal(out, 'a.py:3: error: boom');
  });
});

describe('run_command', () => {
  it('returns exit codes and output', async () => {
    const runner = new CommandRunner(root);
    const tool = makeRunCommand(runner);
    const ok = textOf(await tool.handler({ command: 'echo hi' }));
    assert.match(ok, /exit=0/);
    assert.match(ok, /hi/);
    const bad = textOf(await tool.handler({ command: 'exit 3' }));
    assert.match(bad, /exit=3/);
  });

  it('times out long commands', async () => {
    const runner = new CommandRunner(root);
    const tool = makeRunCommand(runner);
    const out = textOf(await tool.handler({ command: 'sleep 5', timeout_s: 1 }));
    assert.match(out, /exit=124/);
  });
});

describe('git_diff', () => {
  it('shows diffs and clean trees', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fpdiff-'));
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const tool = makeGitDiff(repo);
    assert.match(textOf(await tool.handler({})), /Working tree clean/);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'two\n');
    assert.match(textOf(await tool.handler({})), /two/);
  });
});

describe('propose_edit', () => {
  function deps(): ProposeEditDeps {
    return {
      rootDir: root,
      store: new ProposalStore(),
      readText: (rel) =>
        fs.promises.readFile(path.join(root, rel), 'utf8').catch(() => null),
      writeFinal: (rel, text) => fs.promises.writeFile(path.join(root, rel), text),
    };
  }

  it('prepares, decides, and applies accepted hunks', async () => {
    const file = 'src/edit_me.py';
    fs.writeFileSync(path.join(root, file), 'a = 1\nb = 2\n');
    const d = deps();
    const args = { path: file, edits: [{ old_text: 'a = 1', new_text: 'a = 10' }] };
    const { proposal } = await prepareProposal(d, 'run1', 'p1', args);
    assert.equal(proposal.hunks.length, 1);
    d.store.decide('run1', 'p1', 'h1', 'accepted');
    const outcome = await applyPreparedProposal(d, args);
    assert.deepEqual(outcome.applied, ['h1']);
    assert.deepEqual(outcome.rejected, []);
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'a = 10\nb = 2\n');
  });

  it('reports already-applied edits distinctly from mismatches', async () => {
    const d = deps();
    await assert.rejects(
      prepareProposal(d, 'run1', 'p1', {
        path: 'src/app.py',
        edits: [{ old_text: 'zzz-nope', new_text: 'def main():' }],
      }),
      AlreadyAppliedError,
    );
    await assert.rejects(
      prepareProposal(d, 'run1', 'p2', {
        path: 'src/app.py',
        edits: [{ old_text: 'zzz-nope', new_text: 'zzz-fresh' }],
      }),
      /did not match/,
    );
  });

  it('refuses tool calls with no recorded review', async () => {
    const d = deps();
    await assert.rejects(
      applyPreparedProposal(d, { path: 'src/app.py', content: 'x\n' }),
      /never reviewed/,
    );
  });

  it('refuses stale proposals after external edits', async () => {
    const file = 'src/stale.py';
    fs.writeFileSync(path.join(root, file), 'v = 1\n');
    const d = deps();
    const args = { path: file, edits: [{ old_text: 'v = 1', new_text: 'v = 2' }] };
    await prepareProposal(d, 'run1', 'p1', args);
    d.store.decide('run1', 'p1', 'h1', 'accepted');
    fs.writeFileSync(path.join(root, file), 'v = 99\n');
    await assert.rejects(applyPreparedProposal(d, args), /changed since review/);
  });

  it('stages and applies batched multi-file calls', async () => {
    fs.writeFileSync(path.join(root, 'src', 'one.py'), 'a = 1\n');
    fs.writeFileSync(path.join(root, 'src', 'two.py'), 'b = 2\n');
    const d = deps();
    const args = {
      files: [
        { path: 'src/one.py', edits: [{ old_text: 'a = 1', new_text: 'a = 10' }] },
        { path: 'src/two.py', edits: [{ old_text: 'b = 2', new_text: 'b = 20' }] },
      ],
    };
    let counter = 0;
    const staged = await prepareProposals(d, 'run1', () => `p${++counter}`, args);
    assert.equal(staged.length, 2);
    assert.equal(staged[0].proposal.path, 'src/one.py');
    assert.equal(staged[1].proposal.path, 'src/two.py');
    d.store.decide('run1', 'p1', 'h1', 'accepted');
    d.store.decide('run1', 'p2', 'h1', 'rejected');
    const outcome = await applyPreparedProposal(d, args);
    assert.deepEqual(outcome.applied, ['src/one.py:h1']);
    assert.deepEqual(outcome.rejected, ['src/two.py:h1']);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'one.py'), 'utf8'), 'a = 10\n');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'two.py'), 'utf8'), 'b = 2\n');
  });

  it('stages nothing when any batched file fails', async () => {
    fs.writeFileSync(path.join(root, 'src', 'ok.py'), 'a = 1\n');
    fs.writeFileSync(path.join(root, 'src', 'bad.py'), 'b = 2\n');
    const d = deps();
    let counter = 0;
    await assert.rejects(
      prepareProposals(d, 'run1', () => `p${++counter}`, {
        files: [
          { path: 'src/ok.py', edits: [{ old_text: 'a = 1', new_text: 'a = 10' }] },
          { path: 'src/bad.py', edits: [{ old_text: 'zzz-nope', new_text: 'x' }] },
        ],
      }),
      /did not match/,
    );
    assert.equal(d.store.findAllByHash('whatever').length, 0);
    assert.equal(d.store.getProposal('run1', 'p1'), undefined);
  });

  it('exposes the flow as an MCP tool', async () => {
    const file = 'src/viatool.py';
    fs.writeFileSync(path.join(root, file), 'v = 1\n');
    const d = deps();
    const args = { path: file, edits: [{ old_text: 'v = 1', new_text: 'v = 2' }] };
    await prepareProposal(d, 'run1', 'p1', args);
    d.store.decide('run1', 'p1', 'h1', 'accepted');
    const tool = makeProposeEdit(d);
    const out = textOf(await tool.handler(args));
    assert.match(out, /Applied hunks: h1/);
  });
});
