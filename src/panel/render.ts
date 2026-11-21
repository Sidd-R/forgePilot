// DOM renderers for the agent panel: transcript lines and the context card.
import { TranscriptStore, type TranscriptItem } from './transcript';
import { renderMarkdown } from './markdown';
import { groupPack, noticeLevel, type PackRow, type ReviewedFile } from './present';

export interface ToolTranscriptItem extends TranscriptItem {
  tool?: string;
  /** Subagent that ran this tool, when not the main agent. */
  by?: string;
}

const STATUS_LABEL: Record<string, string> = {
  done: '✓ Done',
  cancelled: '■ Cancelled — unreviewed edits discarded',
  error: '✕ Run failed',
};

const TOOL_ICON: Record<string, string> = {
  read_file: '📄',
  search_code: '🔎',
  find_text: '🔎',
  run_command: '▶',
  get_diagnostics: '⚠',
  git_diff: '±',
  list_symbols: '≡',
  'load tool': '⇣',
  'list tools': '⇣',
};

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** Build the element for a non-streaming line; text lines are filled by the caller. */
function buildLine(kind: string, text: string, tool?: string, by?: string): HTMLElement {
  switch (kind) {
    case 'user':
      return div('msg msg-user', text);
    case 'subagent': {
      const row = div('msg msg-tool msg-subagent');
      row.append(span('icon', '🤖'), span('name', `${tool ?? 'subagent'} started`), span('detail', text));
      row.title = `Subagent ${tool ?? ''}: ${text}`;
      return row;
    }
    case 'tool_call': {
      const row = div(`msg msg-tool${by ? ' by-sub' : ''}`);
      const name = tool ?? kind;
      row.append(span('icon', TOOL_ICON[name] ?? '•'), span('name', name), span('detail', text));
      row.title = `${by ? `${by} · ` : ''}${name} ${text}`;
      return row;
    }
    case 'approval': {
      const isCommand = text.startsWith('command:');
      return div(
        'msg msg-approval',
        isCommand
          ? `⏸ Waiting for approval to run ${text.slice('command:'.length).trim()}`
          : `⏸ Review the highlighted hunks: ${text.replace(/^reviewing\s*/, '')} — use the Accept / Reject lenses in the editor.`,
      );
    }
    case 'review': {
      const accepted = /: (\d+) accepted/.exec(text);
      const ok = accepted !== null && Number(accepted[1]) > 0;
      return div(`msg msg-review ${ok ? 'ok' : 'none'}`, `${ok ? '✓' : '✕'} ${text}`);
    }
    case 'notice':
      return div(`msg msg-notice ${noticeLevel(text)}`, text);
    case 'status':
      return div(`msg msg-status ${text === 'error' ? 'error' : ''}`, STATUS_LABEL[text] ?? `Turn ${text}`);
    default:
      return div('msg msg-notice', text);
  }
}

/** Renderer over one container; the live log and the history view each own one. */
export type OpenFile = (path: string, line: number) => void;

export function createRenderer(container: HTMLElement, onOpen: OpenFile): {
  append: (item: ToolTranscriptItem) => void;
  clear: () => void;
  isEmpty: () => boolean;
} {
  const store = new TranscriptStore();
  const textNodes = new Map<string, HTMLElement>();
  return {
    append(item) {
      if (item.kind === 'tool_result') {
        return; // Legacy "tool finished" lines carry no information.
      }
      if (item.kind === 'context') {
        const pack = parsePack(item.text);
        if (pack) {
          container.appendChild(buildCard(pack, onOpen));
        }
        return;
      }
      if (item.kind === 'subagent_result') {
        container.appendChild(buildSubagentCard(item.tool ?? 'subagent', item.text));
        return;
      }
      if (item.kind === 'changes') {
        const files = parseChanges(item.text);
        if (files.length > 0) {
          container.appendChild(buildChangesCard(files, onOpen));
        }
        return;
      }
      const line = store.append(item);
      if (line.kind !== 'text') {
        container.appendChild(buildLine(line.kind, line.text, item.tool, item.by));
        return;
      }
      let node = textNodes.get(line.key);
      if (!node) {
        if (!line.text.trim()) {
          return; // Empty base message: wait for its first delta.
        }
        node = div('msg msg-text');
        textNodes.set(line.key, node);
        container.appendChild(node);
      }
      node.innerHTML = renderMarkdown(line.text);
    },
    clear() {
      store.clear();
      textNodes.clear();
      container.textContent = '';
    },
    isEmpty: () => container.childElementCount === 0,
  };
}

export interface PackView {
  items: PackRow[];
  totalTokens: number;
  budget: number;
}

/** Context card: files in rank order, why each was picked, budget meter. */
export function buildCard(pack: PackView, onOpen: OpenFile): HTMLElement {
  const card = document.createElement('details');
  card.className = 'card';
  card.open = true;
  const files = groupPack(pack.items);
  const summary = document.createElement('summary');
  summary.append(
    span('title', 'Context picked'),
    span('budget', `${files.length} files · ${pack.totalTokens.toLocaleString()} / ${pack.budget.toLocaleString()} tokens`),
  );
  const meter = div('meter');
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, Math.round((pack.totalTokens / Math.max(1, pack.budget)) * 100))}%`;
  meter.appendChild(fill);
  const rows = div('rows');
  files.forEach((file, index) => {
    const row = div('ctx-row');
    const top = div('ctx-top');
    const link = document.createElement('a');
    link.className = 'ctx-file';
    const ranges = file.ranges.map((r) => `${r.startLine}-${r.endLine}`).join(', ');
    link.textContent = file.path;
    link.title = `Open ${file.path} (lines ${ranges})`;
    link.addEventListener('click', () => onOpen(file.path, file.ranges[0]?.startLine ?? 1));
    top.append(span('ctx-rank', String(index + 1)), link, span('ctx-tokens', `${file.tokens}t`));
    const reason = div('ctx-reason', file.reasons.join(' · '));
    reason.title = `${file.reasons.join('\n')}\nlines ${ranges}`;
    row.append(top, reason);
    rows.appendChild(row);
  });
  card.append(summary, meter, rows);
  return card;
}

function parsePack(text: string): PackView | undefined {
  try {
    const pack = JSON.parse(text) as PackView;
    return Array.isArray(pack.items) ? pack : undefined;
  } catch {
    return undefined;
  }
}

/** End-of-run card: every reviewed file, changed ones clickable first. */
export function buildChangesCard(files: ReviewedFile[], onOpen: OpenFile): HTMLElement {
  const card = document.createElement('details');
  card.className = 'card changes';
  card.open = true;
  const changed = files.filter((f) => f.accepted > 0).length;
  const summary = document.createElement('summary');
  summary.append(
    span('title', changed > 0 ? `Files changed (${changed})` : 'No files changed'),
    span('budget', `${files.length} reviewed`),
  );
  const rows = div('rows');
  for (const file of files) {
    const row = div(`ctx-row ${file.accepted > 0 ? '' : 'unchanged'}`);
    const top = div('ctx-top');
    const link = document.createElement('a');
    link.className = 'ctx-file';
    link.textContent = file.path;
    link.title = `Open ${file.path}`;
    link.addEventListener('click', () => onOpen(file.path, file.line));
    const counts = file.accepted > 0
      ? `${file.accepted} hunk${file.accepted === 1 ? '' : 's'}${file.rejected ? ` · ${file.rejected} rejected` : ''}`
      : 'all rejected';
    top.append(span('ctx-rank', file.accepted > 0 ? '✓' : '✕'), link, span('ctx-tokens', counts));
    row.appendChild(top);
    rows.appendChild(row);
  }
  card.append(summary, rows);
  return card;
}

function parseChanges(text: string): ReviewedFile[] {
  try {
    const files = JSON.parse(text) as unknown;
    return Array.isArray(files) ? (files as ReviewedFile[]) : [];
  } catch {
    return [];
  }
}

/** Subagent's final answer as a collapsible card with its markdown summary. */
export function buildSubagentCard(name: string, text: string): HTMLElement {
  let status = 'done';
  let summary = text;
  try {
    const parsed = JSON.parse(text) as { status?: string; summary?: string };
    status = parsed.status ?? status;
    summary = parsed.summary ?? '';
  } catch {
    // Older/plain payloads: show the text as-is.
  }
  const card = document.createElement('details');
  card.className = `card subagent-result ${status === 'done' ? '' : 'failed'}`;
  card.open = true;
  const head = document.createElement('summary');
  head.append(
    span('title', `🤖 ${name} ${status === 'done' ? 'finished' : status}`),
    span('budget', 'subagent result'),
  );
  const body = div('msg-text sub-body');
  body.innerHTML = summary.trim() ? renderMarkdown(summary) : '<em>No summary returned.</em>';
  card.append(head, body);
  return card;
}
