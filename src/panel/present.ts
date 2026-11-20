/** DOM-free presentation helpers for the agent panel, unit-tested in Node. */

export interface ToolLabel {
  /** Codicon-free glyph so the webview needs no icon font. */
  icon: string;
  label: string;
  detail: string;
}

const ICONS: Record<string, string> = {
  read_file: '📄',
  search_code: '🔎',
  find_text: '🔎',
  propose_edit: '✏️',
  run_command: '▶',
  get_diagnostics: '⚠',
  git_diff: '±',
  list_symbols: '≡',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** One-line summary of a tool call from its name and parsed arguments. */
export function describeTool(name: string, args: Record<string, unknown>): ToolLabel {
  const icon = ICONS[name] ?? '•';
  const path = str(args['path']);
  let detail = '';
  switch (name) {
    case 'read_file': {
      const start = args['start_line'];
      const end = args['end_line'];
      detail = typeof start === 'number' ? `${path}:${start}-${typeof end === 'number' ? end : ''}` : path;
      break;
    }
    case 'search_code':
    case 'find_text':
      detail = `"${str(args['query']) || str(args['pattern']) || str(args['text'])}"`;
      break;
    case 'run_command':
      detail = str(args['command']);
      break;
    case 'propose_edit': {
      const files = Array.isArray(args['files'])
        ? (args['files'] as Array<Record<string, unknown>>).map((file) => str(file['path']))
        : [path];
      detail = files.filter(Boolean).join(', ');
      break;
    }
    default:
      detail = path || str(args['symbol']) || str(args['query']);
  }
  return { icon, label: name, detail: detail.length > 120 ? `${detail.slice(0, 117)}…` : detail };
}

export type NoticeLevel = 'error' | 'warn' | 'info';

/** Pick a visual level for a host notice from its wording. */
export function noticeLevel(text: string): NoticeLevel {
  if (/fall(ing)? ?back|switch|retry|continuing with/i.test(text)) {
    return 'warn';
  }
  if (/fail|error|not running|refused|invalid|unreachable|denied|timed out/i.test(text)) {
    return 'error';
  }
  return 'info';
}

export interface PackRow {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  tokens: number;
}

export interface PackFile {
  path: string;
  tokens: number;
  reasons: string[];
  ranges: Array<{ startLine: number; endLine: number }>;
}

/** Group context items by file, keeping first-seen (rank) order. */
export function groupPack(items: PackRow[]): PackFile[] {
  const byPath = new Map<string, PackFile>();
  for (const item of items) {
    let file = byPath.get(item.path);
    if (!file) {
      file = { path: item.path, tokens: 0, reasons: [], ranges: [] };
      byPath.set(item.path, file);
    }
    file.tokens += item.tokens;
    file.ranges.push({ startLine: item.startLine, endLine: item.endLine });
    if (item.reason && !file.reasons.includes(item.reason)) {
      file.reasons.push(item.reason);
    }
  }
  return [...byPath.values()];
}

/** "1:05" style elapsed time. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** TrueForge web UI deep link for a session. */
export function sessionUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}`;
}
