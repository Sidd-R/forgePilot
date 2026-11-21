/**
 * Shared contracts for ForgePilot. This module must stay free of `vscode`
 * imports so every track (and plain Node tests) can depend on it.
 */

/** Extension settings under the `forgepilot.*` namespace. */
export interface ForgePilotConfig {
  /** TrueForge base URL, e.g. http://localhost:8790 */
  baseUrl: string;
  /** Primary model as `provider/model`. Required before a turn can start. */
  primaryModel: string;
  /** Ordered fallback models tried after the primary fails. */
  fallbackModels: string[];
  /** Token budget for the automatic context pack. */
  tokenBudget: number;
  /** MCP server port. 0 picks a free port. */
  mcpPort: number;
}

export const DEFAULT_CONFIG: ForgePilotConfig = {
  baseUrl: 'http://localhost:8790',
  primaryModel: '',
  fallbackModels: [],
  tokenBudget: 8000,
  mcpPort: 0,
};

/** MCP servers served from the extension host over HTTP on 127.0.0.1. */
export type MCPServerName = 'forge-editor' | 'forge-workspace';

/** Tool names on the `forge-editor` endpoint (preloaded). */
export type EditorToolName =
  | 'read_file'
  | 'search_code'
  | 'find_text'
  | 'propose_edit'
  | 'run_command';

/** Tool names on the `forge-workspace` endpoint (deferred). */
export type WorkspaceToolName = 'get_diagnostics' | 'git_diff' | 'list_symbols';

export type ToolName = EditorToolName | WorkspaceToolName;

/** Tools that pause for user approval before TrueForge may call them. */
export const APPROVAL_TOOLS: readonly EditorToolName[] = [
  'propose_edit',
  'run_command',
];

/** One search-and-replace edit inside a `propose_edit` call. */
export interface TextEdit {
  old_text: string;
  new_text: string;
}

export interface ProposeEditInput {
  /** Workspace-relative path. */
  path: string;
  /** Search-and-replace edits. Omit when `content` is used. */
  edits?: TextEdit[];
  /** Whole-file content for new files or files under ~150 lines. */
  content?: string;
  explanation?: string;
}

export interface ProposeEditResult {
  applied: string[];
  rejected: string[];
  note?: string;
}

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface SearchCodeInput {
  query: string;
  max_tokens?: number;
}

export interface FindTextInput {
  pattern: string;
  glob?: string;
}

export interface RunCommandInput {
  command: string;
  timeout_s?: number;
}

export interface RunCommandResult {
  exit_code: number;
  output: string;
  truncated: boolean;
}

/** One accepted-or-rejected hunk inside a proposal. */
export interface Hunk {
  /** Stable id within the proposal, e.g. `h1`. */
  id: string;
  /** 1-based start line in the original file. */
  startLine: number;
  oldLines: string[];
  newLines: string[];
  decision?: 'accepted' | 'rejected';
}

/** A pending edit awaiting per-hunk review. */
export interface Proposal {
  id: string;
  /** Workspace-relative path. */
  path: string;
  /** True when the file does not exist yet. */
  isNewFile: boolean;
  hunks: Hunk[];
  /** Hash of the tool-call arguments, used to match the approval answer. */
  callHash: string;
  explanation?: string;
}

export type TurnStatus =
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'error';

/** Reduced transcript event rendered by the panel. */
export interface TranscriptEvent {
  kind:
    | 'user'
    | 'text'
    | 'tool_call'
    | 'tool_result'
    | 'approval'
    | 'subagent'
    | 'status'
    | 'notice'
    | 'review'
    | 'context'
    | 'changes'
    | 'subagent_result';
  text: string;
  /** Wire event id; deltas merge into their base message by id. */
  id?: string;
  /** True for streaming delta fragments. */
  delta?: boolean;
  tool?: string;
  /** Set on tool rows run by a subagent: that subagent's name. */
  by?: string;
  durationMs?: number;
  resultBytes?: number;
}

/** One ranked chunk inside a context pack. */
export interface ContextItem {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  /** Human-readable reason, e.g. `symbol match: FlaskGroup`. */
  reason: string;
  tokens: number;
  /** Full chunk text, or a signature-only summary for lower tiers. */
  text: string;
}

export interface ContextPack {
  items: ContextItem[];
  totalTokens: number;
  budget: number;
  /** Short repo outline appended when it fits the budget. */
  outline?: string;
}

/** Serializable checkpoint for undo. */
export interface Checkpoint {
  /** Workspace-relative path, or null for run-level ordering. */
  path: string;
  /** Full original text, or null when the file did not exist. */
  originalText: string | null;
}
