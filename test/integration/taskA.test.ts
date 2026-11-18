import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { TrueForgeClient } from '../../src/trueforge/client';
import { loadAgentFile } from '../../src/trueforge/agents';
import { registerMcpServer, unregisterMcpServer } from '../../src/trueforge/setup';
import { startMcpServer, type RunningMcpServer } from '../../src/mcp/server';
import { ProposalStore } from '../../src/edits/proposals';
import type { ReviewPort, ReviewResult } from '../../src/edits/review';
import {
  makeProposeEdit,
  type ProposeEditDeps,
} from '../../src/mcp/tools/propose_edit';
import { buildInlineInput, runInlineEdit, type InlineTarget } from '../../src/inline/controller';

const BASE_URL = process.env.FORGEPILOT_BASE_URL ?? 'http://localhost:8790';
const MODEL = 'muse/muse-spark-1-3-contributor';
const FIXTURE = '/Users/siddhant/Projects/SideBarSyndicate/flask-fixture';
const VENV_PY = path.join(FIXTURE, '.venv', 'bin', 'python');
const INSTRUCTION =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, " +
  'and update the docstring to list every value that is treated as false.';

/**
 * Task A rehearsal without the editor: the real inline agent turn runs
 * against a scratch clone of Flask, the review is scripted (accept all /
 * reject all), and the FLASK_DEBUG=off check runs in the fixture venv.
 */
describe('task A: inline edit end to end', { timeout: 240_000 }, () => {
  let workdir = '';
  let server: RunningMcpServer | undefined;
  let original = '';

  function target(): InlineTarget {
    const relPath = 'src/flask/helpers.py';
    const full = fs.readFileSync(path.join(workdir, relPath), 'utf8');
    const lines = full.split('\n');
    const start = lines.findIndex((line) => line.startsWith('def get_debug_flag'));
    assert.ok(start >= 0);
    let end = start + 1;
    while (end < lines.length && (lines[end].startsWith(' ') || lines[end] === '')) {
      end++;
    }
    return {
      rootDir: workdir,
      relPath,
      startLine: start + 1,
      endLine: end,
      selectedText: lines.slice(start, end).join('\n'),
      beforeText: lines.slice(Math.max(0, start - 40), start).join('\n'),
      afterText: lines.slice(end, end + 40).join('\n'),
    };
  }

  function depsFor(store: ProposalStore): {
    proposeDeps: ProposeEditDeps;
    client: TrueForgeClient;
  } {
    const proposeDeps: ProposeEditDeps = {
      rootDir: workdir,
      store,
      readText: (rel) => fs.promises.readFile(path.join(workdir, rel), 'utf8').catch(() => null),
      writeFinal: (rel, text) => fs.promises.writeFile(path.join(workdir, rel), text),
    };
    return { proposeDeps, client: new TrueForgeClient(BASE_URL) };
  }

  function autoReview(
    store: ProposalStore,
    accept: boolean,
    seen: { hunks: number },
  ): ReviewPort {
    return {
      open: (_root, runId, proposalId, _newText): Promise<ReviewResult> => {
        const proposal = store.getProposal(runId, proposalId);
        assert.ok(proposal);
        seen.hunks = proposal.hunks.length;
        const decision = accept ? 'accepted' : 'rejected';
        for (const hunk of proposal.hunks) {
          store.decide(runId, proposalId, hunk.id, decision);
        }
        return Promise.resolve({
          accepted: accept ? proposal.hunks.map((h) => h.id) : [],
          rejected: accept ? [] : proposal.hunks.map((h) => h.id),
        });
      },
    };
  }

  before(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fptaska-'));
    execSync(`git -C ${FIXTURE} archive demo | tar -x -C ${workdir}`);
    original = fs.readFileSync(path.join(workdir, 'src/flask/helpers.py'), 'utf8');
  });

  after(async () => {
    await unregisterMcpServer(BASE_URL, 'forge-editor').catch(() => undefined);
    await server?.close();
  });

  async function withServer<T>(proposeDeps: ProposeEditDeps, fn: () => Promise<T>): Promise<T> {
    server = await startMcpServer({
      port: 0,
      token: 'taska-token',
      endpoints: [{ name: 'forge-editor', tools: [makeProposeEdit(proposeDeps)] }],
    });
    try {
      await registerMcpServer(BASE_URL, {
        name: 'forge-editor',
        url: server.urlFor('forge-editor'),
        description: 'Task A rehearsal',
        token: 'taska-token',
      });
      return await fn();
    } finally {
      await server.close().catch(() => undefined);
      server = undefined;
    }
  }

  function inlineSpec(): ReturnType<typeof loadAgentFile>['manifest'] {
    return loadAgentFile(
      '/Users/siddhant/Projects/SideBarSyndicate/forgePilot/agents',
      'forgepilot-inline.yaml',
      MODEL,
    ).manifest;
  }

  it('accept path: two hunks, applied, FLASK_DEBUG=off is False', async () => {
    const store = new ProposalStore();
    const seen = { hunks: 0 };
    const review = autoReview(store, true, seen);
    const { proposeDeps, client } = depsFor(store);
    await withServer(proposeDeps, async () => {
      const outcome = await runInlineEdit({
        client,
        spec: inlineSpec(),
        models: [MODEL],
        target: target(),
        instruction: INSTRUCTION,
        store,
        review,
        proposeDeps,
        readFullText: () =>
          fs.promises.readFile(path.join(workdir, 'src/flask/helpers.py'), 'utf8'),
        diagnostics: () => [],
        onNotice: () => undefined,
        isCancelled: () => false,
        fixLimit: 0,
      });
      assert.equal(outcome, 'applied');
      assert.ok(seen.hunks >= 2, `expected 2+ hunks, got ${seen.hunks}`);
      const updated = fs.readFileSync(path.join(workdir, 'src/flask/helpers.py'), 'utf8');
      assert.match(updated, /["']off["']/);
      assert.match(updated, /["']n["']/);
      const printed = execFileSync(
        VENV_PY,
        ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'],
        {
          cwd: workdir,
          encoding: 'utf8',
          env: {
            ...process.env,
            FLASK_DEBUG: 'off',
            PYTHONPATH: path.join(workdir, 'src'),
          },
        },
      ).trim();
      assert.equal(printed, 'False');
    });
  });

  it('reject path: file stays byte-identical', async () => {
    fs.writeFileSync(path.join(workdir, 'src/flask/helpers.py'), original);
    const store = new ProposalStore();
    const review = autoReview(store, false, { hunks: 0 });
    const { proposeDeps, client } = depsFor(store);
    await withServer(proposeDeps, async () => {
      const t = target();
      const input = buildInlineInput(t, INSTRUCTION);
      assert.match(input, /edit ONLY this range/);
      const outcome = await runInlineEdit({
        client,
        spec: inlineSpec(),
        models: [MODEL],
        target: t,
        instruction: INSTRUCTION,
        store,
        review,
        proposeDeps,
        readFullText: () =>
          fs.promises.readFile(path.join(workdir, 'src/flask/helpers.py'), 'utf8'),
        diagnostics: () => [],
        onNotice: () => undefined,
        isCancelled: () => false,
        fixLimit: 0,
      });
      assert.equal(outcome, 'rejected');
      assert.equal(fs.readFileSync(path.join(workdir, 'src/flask/helpers.py'), 'utf8'), original);
    });
  });
});
