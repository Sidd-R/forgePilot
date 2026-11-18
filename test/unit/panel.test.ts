import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, renderPack } from '../../src/panel/prompt';
import { CodeIndex } from '../../src/context/index';
import { buildPack } from '../../src/context/pack';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('parseMentions', () => {
  it('resolves @file and @symbol, leaving text readable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpmen-'));
    fs.writeFileSync(path.join(root, 'cli.py'), 'def run_command():\n    pass\n');
    const index = CodeIndex.build(root);
    const parsed = parseMentions(index, 'change @file cli and @symbol run_command now');
    assert.deepEqual(parsed.files, ['cli.py']);
    assert.deepEqual(parsed.symbols, ['run_command']);
    assert.match(parsed.clean, /cli\.py/);
  });

  it('leaves unknown mentions untouched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpmen-'));
    fs.writeFileSync(path.join(root, 'a.py'), 'x = 1\n');
    const index = CodeIndex.build(root);
    const parsed = parseMentions(index, 'see @file nope.py here');
    assert.deepEqual(parsed.files, []);
    assert.match(parsed.clean, /@file nope\.py/);
  });
});

describe('renderPack', () => {
  it('renders items with reasons plus the request', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fppack-'));
    fs.writeFileSync(path.join(root, 'cli.py'), 'def run_command():\n    pass\n');
    const index = CodeIndex.build(root);
    const pack = buildPack(index, 'add command', { budget: 8000 });
    const rendered = renderPack(pack, 'add command');
    assert.match(rendered, /\[Context:/);
    assert.match(rendered, /cli\.py/);
    assert.match(rendered, /User request: add command/);
  });
});
