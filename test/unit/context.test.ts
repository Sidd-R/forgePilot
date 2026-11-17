import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodeIndex, chunkFile, estimateTokens } from '../../src/context/index';
import { buildPack } from '../../src/context/pack';
import { partnerFiles } from '../../src/context/partners';
import {
  resolveFileMention,
  resolveSymbolMention,
  tokenizeRequest,
} from '../../src/context/mentions';

const CLI_PY = `"""Command line interface."""
import click


class FlaskGroup(click.Group):
    """Top level command runner."""

    def make_context(self, *args):
        return super().make_context(*args)


def run_command(app, host, port):
    """Run the app."""
    app.run(host, port)


def routes_command(sort, all_methods):
    """Show all registered routes."""
    pass


def shell_command():
    """Open a shell."""
    pass
`;

const CONFIG_PY = `"""App config."""


class Config(dict):
    """Configuration object."""

    def from_object(self, obj):
        pass
`;

const TEST_CLI = `import pytest


def test_routes(runner):
    result = runner.invoke(args=["routes"])
    assert result.exit_code == 0
`;

const CLI_RST = `Command Line Interface
======================

.. contents::

Open a Shell
------------

Use the shell command.

Run the Server
--------------

Use the run command.
`;

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpctx-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'cli.py'), CLI_PY);
  fs.writeFileSync(path.join(root, 'src', 'config.py'), CONFIG_PY);
  fs.writeFileSync(path.join(root, 'tests', 'test_cli.py'), TEST_CLI);
  fs.writeFileSync(path.join(root, 'docs', 'cli.rst'), CLI_RST);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'just some notes\n');
});

describe('chunkFile', () => {
  it('splits python at module-level defs, keeping methods in the class', () => {
    const chunks = chunkFile('src/cli.py', CLI_PY);
    const symbols = chunks.map((c) => c.symbol);
    assert.deepEqual(symbols, [undefined, 'FlaskGroup', 'run_command', 'routes_command', 'shell_command']);
    const cls = chunks.find((c) => c.symbol === 'FlaskGroup');
    assert.ok(cls?.text.includes('make_context'));
  });

  it('splits rst by section heading', () => {
    const chunks = chunkFile('docs/cli.rst', CLI_RST);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.some((c) => c.symbol === 'Open a Shell'));
  });

  it('falls back to windows for plain text', () => {
    const chunks = chunkFile('notes.txt', 'just some notes\n');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].kind, 'window');
  });
});

describe('tokenizeRequest', () => {
  it('drops filler and keeps code words', () => {
    const tokens = tokenizeRequest('Add a new built-in CLI command flask config');
    assert.ok(!tokens.includes('a'));
    assert.ok(!tokens.includes('new'));
    assert.ok(tokens.includes('cli'));
    assert.ok(tokens.includes('config'));
  });
});

describe('CodeIndex', () => {
  it('indexes symbols and searches by rare words', () => {
    const index = CodeIndex.build(root);
    assert.ok(index.symbols.has('FlaskGroup'));
    assert.ok(index.symbols.has('routes_command'));
    const hits = index.search('routes registered', 5);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].chunk.symbol, 'routes_command');
  });

  it('builds a repo map', () => {
    const index = CodeIndex.build(root);
    assert.deepEqual(index.repoMap.get('src/cli.py'), [
      'FlaskGroup',
      'run_command',
      'routes_command',
      'shell_command',
    ]);
  });

  it('reads co-change history from git', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fpco-'));
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'a.py'), 'a = 1\n');
    fs.writeFileSync(path.join(repo, 'b.py'), 'b = 2\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'both');
    fs.writeFileSync(path.join(repo, 'a.py'), 'a = 3\n');
    fs.writeFileSync(path.join(repo, 'b.py'), 'b = 4\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'both again');
    const index = CodeIndex.build(repo);
    await index.loadCochange(repo);
    const partners = index.cochange.get('a.py') ?? [];
    assert.equal(partners[0].file, 'b.py');
    assert.equal(partners[0].count, 2);
  });
});

describe('partnerFiles', () => {
  it('maps source to test and docs partners', () => {
    const known = new Set(['src/cli.py', 'tests/test_cli.py', 'docs/cli.rst', 'CHANGES.rst']);
    const partners = partnerFiles('src/cli.py', known);
    assert.ok(partners.includes('tests/test_cli.py'));
    assert.ok(partners.includes('docs/cli.rst'));
  });
});

describe('buildPack', () => {
  const query =
    'Add a built-in flask config CLI command that prints app config as JSON and masks secret keys, with a test and docs';

  it('ranks cli, its test, and its docs without mentions', () => {
    const index = CodeIndex.build(root);
    const pack = buildPack(index, query, { budget: 8000 });
    const paths = pack.items.map((item) => item.path);
    assert.ok(paths.includes('src/cli.py'));
    assert.ok(paths.includes('tests/test_cli.py'));
    assert.ok(paths.includes('docs/cli.rst'));
    assert.ok(pack.totalTokens <= 8000);
    for (const item of pack.items) {
      assert.ok(item.reason.length > 0);
    }
  });

  it('never exceeds a small budget', () => {
    const index = CodeIndex.build(root);
    const pack = buildPack(index, query, { budget: 300 });
    assert.ok(pack.totalTokens <= 300);
  });

  it('caps automatic picks at three chunks per file', () => {
    const index = CodeIndex.build(root);
    const pack = buildPack(index, query, { budget: 8000 });
    const counts = new Map<string, number>();
    for (const item of pack.items) {
      counts.set(item.path, (counts.get(item.path) ?? 0) + 1);
    }
    for (const [, count] of counts) {
      assert.ok(count <= 3);
    }
  });

  it('puts mentioned files first within half the budget each', () => {
    const index = CodeIndex.build(root);
    const pack = buildPack(index, query, {
      budget: 8000,
      mentionedFiles: ['src/config.py'],
    });
    assert.equal(pack.items[0].path, 'src/config.py');
    assert.equal(pack.items[0].reason, 'mentioned by user');
  });

  it('estimateTokens stays sane', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
  });
});

describe('mentions', () => {
  it('resolves @file fuzzily', () => {
    const index = CodeIndex.build(root);
    assert.deepEqual(resolveFileMention(index, 'test_cli'), ['tests/test_cli.py']);
  });

  it('resolves @symbol from the index', () => {
    const index = CodeIndex.build(root);
    const hits = resolveSymbolMention(index, 'flaskgroup');
    assert.equal(hits[0].symbol, 'FlaskGroup');
    assert.equal(hits[0].path, 'src/cli.py');
  });
});
