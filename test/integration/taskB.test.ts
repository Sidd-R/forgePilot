import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { TrueForgeClient } from '../../src/trueforge/client';
import { loadAgentFile } from '../../src/trueforge/agents';
import type { TranscriptEvent } from '../../src/types';
import { registerMcpServer, unregisterMcpServer } from '../../src/trueforge/setup';
import { startMcpServer, type RunningMcpServer } from '../../src/mcp/server';
import { ProposalStore } from '../../src/edits/proposals';
import type { ReviewPort, ReviewResult } from '../../src/edits/review';
import { makeReadFile } from '../../src/mcp/tools/read_file';
import { makeSearchCode } from '../../src/mcp/tools/search_code';
import { makeFindText } from '../../src/mcp/tools/find_text';
import { makeProposeEdit, type ProposeEditDeps } from '../../src/mcp/tools/propose_edit';
import { CommandRunner, makeRunCommand } from '../../src/mcp/tools/run_command';
import { makeGetDiagnostics } from '../../src/mcp/tools/get_diagnostics';
import { makeGitDiff } from '../../src/mcp/tools/git_diff';
import { makeListSymbols } from '../../src/mcp/tools/list_symbols';
import { CodeIndex } from '../../src/context/index';
import { buildPack } from '../../src/context/pack';
import { renderPack } from '../../src/panel/prompt';
import { runAgentTurn } from '../../src/flows/agent';

const BASE_URL = process.env.FORGEPILOT_BASE_URL ?? 'http://localhost:8790';
const MODEL = 'muse/muse-spark-1-3-contributor';
const FIXTURE = '/Users/siddhant/Projects/SideBarSyndicate/flask-fixture';
const VENV_PY = path.join(FIXTURE, '.venv', 'bin', 'python');
const PROMPT =
  'Add a new built-in CLI command flask config that prints the loaded application\'s ' +
  'configuration as JSON, masking the values of any key containing SECRET, PASSWORD, ' +
  'TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and ' +
  'be documented alongside the other built-in commands.';

/**
 * Task B rehearsal without the editor: the real coder agent turn runs
 * against a scratch git clone of Flask with scripted accept-all review,
 * then the pytest, --help, masked-JSON, and undo checks run for real.
 */
describe('task B: agent mode end to end', { timeout: 900_000 }, () => {
  let workdir = '';
  let demoApp = '';
  let server: RunningMcpServer | undefined;
  const reviewed: Array<{ runId: string; proposalId: string }> = [];

  function autoReview(store: ProposalStore): ReviewPort {
    return {
      open: (_root, runId, proposalId, _newText): Promise<ReviewResult> => {
        const proposal = store.getProposal(runId, proposalId);
        assert.ok(proposal);
        for (const hunk of proposal.hunks) {
          store.decide(runId, proposalId, hunk.id, 'accepted');
        }
        reviewed.push({ runId, proposalId });
        return Promise.resolve({
          accepted: proposal.hunks.map((h) => h.id),
          rejected: [],
        });
      },
    };
  }

  function venvEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PYTHONPATH: path.join(workdir, 'src') };
  }

  before(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fptaskb-'));
    execSync(`git -C ${FIXTURE} archive demo | tar -x -C ${workdir}`);
    execSync(`git -C ${workdir} init -q && git -C ${workdir} add -A && git -C ${workdir} -c user.email=t@t -c user.name=t commit -qm init`);
    fs.appendFileSync(path.join(workdir, '.git', 'info', 'exclude'), '.venv\n');
    fs.symlinkSync(path.join(FIXTURE, '.venv'), path.join(workdir, '.venv'));
    const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpdemo-'));
    demoApp = path.join(demoDir, 'demo_app.py');
    fs.writeFileSync(
      demoApp,
      'from flask import Flask\n' +
        "app = Flask(__name__)\n" +
        "app.config['SECRET_KEY'] = 'super-secret'\n" +
        "app.config['API_TOKEN'] = 'tok123'\n" +
        "app.config['PLAIN_VALUE'] = 'visible'\n",
    );
  });

  after(async () => {
    await unregisterMcpServer(BASE_URL, 'forge-editor').catch(() => undefined);
    await unregisterMcpServer(BASE_URL, 'forge-workspace').catch(() => undefined);
    await server?.close().catch(() => undefined);
  });

  it('agent discovers and edits 3+ files, tests pass, undo works', async () => {
    const store = new ProposalStore();
    const review = autoReview(store);
    const index = CodeIndex.build(workdir);
    await index.loadCochange(workdir);
    const runner = new CommandRunner(workdir);
    const proposeDeps: ProposeEditDeps = {
      rootDir: workdir,
      store,
      readText: (rel) => fs.promises.readFile(path.join(workdir, rel), 'utf8').catch(() => null),
      writeFinal: (rel, text) => fs.promises.writeFile(path.join(workdir, rel), text),
    };
    server = await startMcpServer({
      port: 0,
      token: 'taskb-token',
      endpoints: [
        {
          name: 'forge-editor',
          tools: [
            makeReadFile(workdir),
            makeSearchCode(() => index),
            makeFindText(workdir),
            makeProposeEdit(proposeDeps),
            makeRunCommand(runner),
          ],
        },
        {
          name: 'forge-workspace',
          tools: [
            makeGetDiagnostics(() => []),
            makeGitDiff(workdir),
            makeListSymbols(workdir, () => index),
          ],
        },
      ],
    });
    try {
      await registerMcpServer(BASE_URL, {
        name: 'forge-editor',
        url: server.urlFor('forge-editor'),
        description: 'Task B rehearsal',
        token: 'taskb-token',
      });
      await registerMcpServer(BASE_URL, {
        name: 'forge-workspace',
        url: server.urlFor('forge-workspace'),
        description: 'Task B rehearsal',
        token: 'taskb-token',
      });
      const pack = buildPack(index, PROMPT, { budget: 8000 });
      const packPaths = pack.items.map((item) => item.path);
      assert.ok(packPaths.includes('src/flask/cli.py'));
      assert.ok(packPaths.includes('tests/test_cli.py'));
      assert.ok(packPaths.includes('docs/cli.rst'));

      const client = new TrueForgeClient(BASE_URL);
      const spec = loadAgentFile(
        '/Users/siddhant/Projects/SideBarSyndicate/forgePilot/agents',
        'forgepilot-coder.yaml',
        MODEL,
      ).manifest;
      const transcript: TranscriptEvent[] = [];
      const result = await runAgentTurn({
        client,
        spec,
        models: [MODEL],
        input: renderPack(pack, PROMPT),
        store,
        review,
        proposeDeps,
        askCommand: () => Promise.resolve('once'),
        onTranscript: (event) => transcript.push(event),
        onNotice: () => undefined,
        isCancelled: () => false,
      });
      assert.equal(result.status, 'done');
      const kinds = transcript.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {});
      process.stdout.write(`# transcript kinds: ${JSON.stringify(kinds)}\n`);
      for (const event of transcript.filter((e) => e.kind.startsWith('subagent'))) {
        process.stdout.write(`# ${event.kind} ${event.tool}: ${event.text.slice(0, 160).replace(/\n/g, ' ')}\n`);
      }

      const status = execSync(`git -C ${workdir} status --short`, { encoding: 'utf8' });
      const changed = status.trim().split('\n').filter(Boolean);
      assert.ok(changed.length >= 3, `expected 3+ files, got:\n${status}`);
      // Scope: the request adds `config`; existing gaps (e.g. routes_command
      // missing from docs/api.rst) must stay untouched.
      const diff = execSync(`git -C ${workdir} diff`, { encoding: 'utf8' });
      process.stdout.write(`# changed files:\n${status}`);
      const strayRoutes = diff.split('\n').filter((l) => l.startsWith('+') && /routes/i.test(l));
      assert.deepEqual(strayRoutes, [], `edits outside the request:\n${diff}`);

      execFileSync(VENV_PY, ['-m', 'pytest', 'tests/test_cli.py', '-q'], {
        cwd: workdir,
        encoding: 'utf8',
        env: venvEnv(),
        stdio: 'pipe',
      });

      const help = execFileSync(VENV_PY, ['-m', 'flask', '--help'], {
        cwd: workdir,
        encoding: 'utf8',
        env: venvEnv(),
      });
      assert.match(help, /config/);

      const configOut = execFileSync(VENV_PY, ['-m', 'flask', '--app', demoApp, 'config'], {
        cwd: workdir,
        encoding: 'utf8',
        env: venvEnv(),
      });
      const parsed = JSON.parse(configOut) as Record<string, string>;
      assert.equal(parsed['SECRET_KEY'], '***');
      assert.equal(parsed['API_TOKEN'], '***');
      assert.equal(parsed['PLAIN_VALUE'], 'visible');

      const last = reviewed[reviewed.length - 1];
      assert.ok(last);
      const restores = store.undoLast(last.runId);
      assert.ok(restores.length > 0);
      const preUndo = new Map<string, string | null>();
      for (const restore of restores) {
        preUndo.set(
          restore.path,
          fs.existsSync(path.join(workdir, restore.path))
            ? fs.readFileSync(path.join(workdir, restore.path), 'utf8')
            : null,
        );
      }
      for (const restore of restores) {
        if (restore.text === null) {
          fs.rmSync(path.join(workdir, restore.path));
        } else {
          fs.writeFileSync(path.join(workdir, restore.path), restore.text);
        }
      }
      let reverted = 0;
      for (const restore of restores) {
        const after = fs.existsSync(path.join(workdir, restore.path))
          ? fs.readFileSync(path.join(workdir, restore.path), 'utf8')
          : null;
        assert.equal(after, restore.text);
        if (after !== preUndo.get(restore.path)) {
          reverted++;
        }
      }
      assert.ok(reverted > 0);
    } finally {
      await server.close().catch(() => undefined);
      server = undefined;
    }
  });
});
