import * as vscode from 'vscode';
import type { CommandChoice } from '../flows/turns';
import type { CodeIndex } from '../context/index';
import { resolveInside } from '../mcp/tools/jail';
import { resolveFileMention, resolveSymbolMention } from '../context/mentions';

// Editor-side requests from the panel: command approval, file opening, mentions.

/** Webview -> host messages. */
export interface PanelInbound {
  type:
    | 'prompt'
    | 'cancel'
    | 'undoLast'
    | 'undoRun'
    | 'newChat'
    | 'mentionQuery'
    | 'historyList'
    | 'historyOpen'
    | 'openFile'
    | 'openSession';
  text?: string;
  kind?: 'file' | 'symbol';
  query?: string;
  id?: number;
  chatId?: string;
  path?: string;
  line?: number;
}

export interface PanelActions {
  cancel: () => Promise<void>;
  undoLast: () => Promise<void>;
  undoRun: () => Promise<void>;
}

/** Modal so a pending command can never hide in the notification tray. */
export async function askCommand(command: string): Promise<CommandChoice> {
  const choice = await vscode.window.showInformationMessage(
    `ForgePilot wants to run: ${command}`,
    { modal: true, detail: 'The agent is paused until you decide. Cancel denies the command.' },
    'Allow once',
    'Allow for this session',
  );
  if (choice === 'Allow for this session') {
    return 'session';
  }
  return choice === 'Allow once' ? 'once' : 'deny';
}

export async function openWorkspaceFile(rootDir: string, relPath: string, line: number): Promise<void> {
  const uri = vscode.Uri.file(resolveInside(rootDir, relPath).abs);
  const at = Math.max(0, line - 1);
  await vscode.window.showTextDocument(uri, { selection: new vscode.Range(at, 0, at, 0), preview: true });
}

export function mentionItems(index: CodeIndex, kind: 'file' | 'symbol', query: string): string[] {
  return kind === 'file'
    ? resolveFileMention(index, query)
    : resolveSymbolMention(index, query).map((hit) => `${hit.symbol} (${hit.path}:${hit.startLine})`);
}

export function errorText(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
