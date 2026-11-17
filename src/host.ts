import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { ForgePilotConfig } from './types';
import { TrueForgeClient } from './trueforge/client';
import { registerMcpServer } from './trueforge/setup';
import { startMcpServer, type RunningMcpServer } from './mcp/server';
import { makeReadFile } from './mcp/tools/read_file';
import { makeSearchCode } from './mcp/tools/search_code';
import { makeFindText } from './mcp/tools/find_text';
import { makeProposeEdit, type ProposeEditDeps } from './mcp/tools/propose_edit';
import { CommandRunner, makeRunCommand } from './mcp/tools/run_command';
import { makeGetDiagnostics, type DiagnosticItem } from './mcp/tools/get_diagnostics';
import { makeGitDiff } from './mcp/tools/git_diff';
import { makeListSymbols } from './mcp/tools/list_symbols';
import { CodeIndex } from './context/index';
import {
  ProposalStore,
  applyText,
  initVscode,
  readText,
  writeFile,
} from './edits/proposals';
import { ReviewController } from './edits/review';

/** Wired extension services, built once at activation. */
export interface Host {
  rootDir: string;
  client: TrueForgeClient;
  store: ProposalStore;
  review: ReviewController;
  runner: CommandRunner;
  index: CodeIndex;
  /** Live index handle for tools; updated on every rebuild. */
  indexBox: { index: CodeIndex };
  mcp: RunningMcpServer;
  proposeDeps: ProposeEditDeps;
  agentsDir: string;
  config: ForgePilotConfig;
  activeSession: string | undefined;
  cancelled: boolean;
  lastRunId: string | undefined;
}

export function readConfig(): ForgePilotConfig {
  const cfg = vscode.workspace.getConfiguration('forgepilot');
  return {
    baseUrl: cfg.get('trueforge.baseUrl', 'http://localhost:8790'),
    primaryModel: cfg.get('models.primary', ''),
    fallbackModels: cfg.get('models.fallbacks', []),
    tokenBudget: cfg.get('context.tokenBudget', 8000),
    mcpPort: cfg.get('mcp.port', 0),
  };
}

export function collectDiagnostics(relPath?: string): DiagnosticItem[] {
  const out: DiagnosticItem[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    const rel = vscode.workspace.asRelativePath(uri);
    if (relPath && rel !== relPath) {
      continue;
    }
    for (const diag of diags) {
      if (
        diag.severity !== vscode.DiagnosticSeverity.Error &&
        diag.severity !== vscode.DiagnosticSeverity.Warning
      ) {
        continue;
      }
      out.push({
        path: rel,
        line: diag.range.start.line + 1,
        severity: diag.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        message: diag.message.slice(0, 300),
      });
    }
  }
  return out;
}

/** Build services, start the MCP server, and register it with TrueForge. */
export async function buildHost(
  extensionUri: vscode.Uri,
): Promise<Host> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('ForgePilot needs an open workspace folder.');
  }
  const rootDir = folder.uri.fsPath;
  const config = readConfig();
  initVscode(vscode);
  const client = new TrueForgeClient(config.baseUrl);
  const store = new ProposalStore();
  const review = new ReviewController(store);
  const runner = new CommandRunner(rootDir);
  const index = CodeIndex.build(rootDir);
  void index.loadCochange(rootDir);
  const proposeDeps: ProposeEditDeps = {
    rootDir,
    store,
    readText: (rel) => readText(rootDir, rel),
    writeFinal: async (rel, text) => {
      if ((await readText(rootDir, rel)) === null) {
        await writeFile(rootDir, rel, text);
      } else {
        await applyText(rootDir, rel, text, true);
      }
    },
  };
  const token = crypto.randomBytes(32).toString('hex');
  const indexBox: { index: CodeIndex } = { index };
  const mcp = await startMcpServer({
    port: config.mcpPort,
    token,
    endpoints: [
      {
        name: 'forge-editor',
        tools: [
          makeReadFile(rootDir),
          makeSearchCode(() => indexBox.index),
          makeFindText(rootDir),
          makeProposeEdit(proposeDeps),
          makeRunCommand(runner),
        ],
      },
      {
        name: 'forge-workspace',
        tools: [
          makeGetDiagnostics(collectDiagnostics),
          makeGitDiff(rootDir),
          makeListSymbols(rootDir, () => indexBox.index),
        ],
      },
    ],
  });
  await registerMcpServer(config.baseUrl, {
    name: 'forge-editor',
    url: mcp.urlFor('forge-editor'),
    description: 'ForgePilot core editor tools',
    token,
  });
  await registerMcpServer(config.baseUrl, {
    name: 'forge-workspace',
    url: mcp.urlFor('forge-workspace'),
    description: 'ForgePilot secondary workspace tools',
    token,
  });
  return {
    rootDir,
    client,
    store,
    review,
    runner,
    index,
    indexBox,
    mcp,
    proposeDeps,
    agentsDir: vscode.Uri.joinPath(extensionUri, 'agents').fsPath,
    config,
    activeSession: undefined,
    cancelled: false,
    lastRunId: undefined,
  };
}
