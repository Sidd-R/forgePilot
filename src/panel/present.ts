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
      detail = `"${str(args['query'])}"`;
      break;
    case 'find_text': {
      const pattern = str(args['pattern']) || str(args['query']);
      const glob = str(args['glob']);
      detail = pattern
        ? `"${pattern}"${glob ? ` in ${glob}` : ''}`
        : `list files ${glob || '(workspace)'}`;
      break;
    }
    case 'call_tool': {
      // Deferred tool loading: show the real tool and its target.
      const inner = str(args['tool_name']) || 'tool';
      const input = typeof args['input'] === 'object' && args['input'] !== null
        ? (args['input'] as Record<string, unknown>)
        : {};
      const innerDetail = describeTool(inner, input).detail;
      return {
        icon: ICONS[inner] ?? icon,
        label: inner,
        detail: `${innerDetail ? `${innerDetail} · ` : ''}deferred via ${str(args['mcp_server']) || 'MCP'}`,
      };
    }
    case 'get_tool_info':
      return { icon: '⇣', label: 'load tool', detail: `${str(args['mcp_server'])}/${str(args['tool_name'])}` };
    case 'list_tools':
      return { icon: '⇣', label: 'list tools', detail: str(args['mcp_server']) || 'all servers' };
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

/**
 * One file's reasons as short unique phrases: the per-chunk reason strings
 * ("a; b; c") are split, the `matched "x", "y"` phrases are merged into a
 * single list of at most five words, and everything else is deduplicated.
 */
function mergeReasons(reasons: string[]): string[] {
  const words: string[] = [];
  const other: string[] = [];
  for (const piece of reasons.flatMap((reason) => reason.split('; '))) {
    const quoted = piece.startsWith('matched ') ? [...piece.matchAll(/"([^"]+)"/g)] : [];
    if (quoted.length > 0) {
      for (const [, word] of quoted) {
        if (!words.includes(word)) {
          words.push(word);
        }
      }
    } else if (piece && !other.includes(piece)) {
      other.push(piece);
    }
  }
  const matched = words.length > 0 ? [`matched ${words.slice(0, 5).join(', ')}`] : [];
  return [...matched, ...other];
}

/** Group context items by file, keeping first-seen (rank) order. */
export function groupPack(items: PackRow[]): PackFile[] {
  const byPath = new Map<string, PackFile & { raw: string[] }>();
  for (const item of items) {
    let file = byPath.get(item.path);
    if (!file) {
      file = { path: item.path, tokens: 0, reasons: [], ranges: [], raw: [] };
      byPath.set(item.path, file);
    }
    file.tokens += item.tokens;
    file.ranges.push({ startLine: item.startLine, endLine: item.endLine });
    if (item.reason) {
      file.raw.push(item.reason);
    }
  }
  return [...byPath.values()].map(({ raw, ...file }) => ({ ...file, reasons: mergeReasons(raw) }));
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

export interface ReviewedFile {
  path: string;
  accepted: number;
  rejected: number;
  /** First accepted hunk's line (1-based) in the original file. */
  line: number;
  /** The agent's reason for changing this file. */
  why?: string;
}

/**
 * Per-file outcome of a run: repeated reviews of one file merge, changed
 * files (any accepted hunk) come first in review order, then untouched.
 */
export function summarizeChanges(reviews: ReviewedFile[]): ReviewedFile[] {
  const byPath = new Map<string, ReviewedFile>();
  for (const review of reviews) {
    const seen = byPath.get(review.path);
    if (!seen) {
      byPath.set(review.path, { ...review });
      continue;
    }
    if (seen.accepted === 0 && review.accepted > 0) {
      seen.line = review.line;
    }
    if (review.why && (review.accepted > 0 || !seen.why)) {
      seen.why = review.why;
    }
    seen.accepted += review.accepted;
    seen.rejected += review.rejected;
  }
  const files = [...byPath.values()];
  return [...files.filter((f) => f.accepted > 0), ...files.filter((f) => f.accepted === 0)];
}
