// Agent panel UI: prompt box with @ completion, context card, transcript.
import { TranscriptStore } from './transcript';
import { renderMarkdown } from './markdown';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing #${id}`);
  }
  return node as T;
}

const card = el('card');
const log = el('log');
const promptBox = el<HTMLTextAreaElement>('prompt');
const complete = el('complete');
const sendButton = el<HTMLButtonElement>('send');
const overlay = el('overlay');
let queryId = 0;

const KIND_CLASS: Record<string, string> = {
  text: 'msg',
  tool_call: 'msg msg-tool',
  tool_result: 'msg msg-tool',
  subagent: 'msg msg-tool',
  approval: 'msg msg-approval',
  status: 'msg msg-notice',
  notice: 'msg msg-notice',
};

interface TranscriptItem {
  kind: string;
  text: string;
  id?: string;
  delta?: boolean;
}

/** Renderer over one container; the live log and the history view each own one. */
function createRenderer(container: HTMLElement): {
  append: (item: TranscriptItem) => void;
  clear: () => void;
} {
  const store = new TranscriptStore();
  const spans = new Map<string, HTMLElement>();
  return {
    append(item) {
      const line = store.append(item);
      let span = spans.get(line.key);
      if (!span) {
        span = document.createElement('span');
        spans.set(line.key, span);
        const div = document.createElement('div');
        div.className = KIND_CLASS[line.kind] ?? 'msg';
        if (line.kind !== 'text') {
          div.append(`[${line.kind}] `);
        }
        div.appendChild(span);
        container.appendChild(div);
      }
      if (line.kind === 'text') {
        span.innerHTML = renderMarkdown(line.text);
      } else {
        span.textContent = line.text;
      }
    },
    clear() {
      store.clear();
      spans.clear();
      container.textContent = '';
    },
  };
}

const live = createRenderer(log);

function sendPrompt(): void {
  const text = promptBox.value.trim();
  if (!text || sendButton.disabled) {
    return;
  }
  vscode.postMessage({ type: 'prompt', text });
  promptBox.value = '';
}

sendButton.addEventListener('click', sendPrompt);
el('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
el('newchat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
el('history').addEventListener('click', () => vscode.postMessage({ type: 'historyList' }));
el('undo1').addEventListener('click', () => vscode.postMessage({ type: 'undoLast' }));
el('undoRun').addEventListener('click', () => vscode.postMessage({ type: 'undoRun' }));
promptBox.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

promptBox.addEventListener('input', () => {
  const match = /(?:^|\s)@(file|symbol)\s+([^\s@]*)$/.exec(promptBox.value);
  if (!match) {
    complete.style.display = 'none';
    return;
  }
  queryId += 1;
  vscode.postMessage({ type: 'mentionQuery', kind: match[1], query: match[2], id: queryId });
});

interface PackItem {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  tokens: number;
}

interface Inbound {
  type: string;
  events?: TranscriptItem[];
  pack?: { items: PackItem[]; totalTokens: number; budget: number };
  running?: boolean;
  id?: number;
  items?: Array<string | { id: string; startedAt: number; title: string }>;
}

function scrollBottom(): void {
  window.scrollTo(0, document.body.scrollHeight);
}

function renderCard(pack: NonNullable<Inbound['pack']>): void {
  card.textContent = '';
  const head = document.createElement('div');
  head.className = 'ctx-head';
  head.textContent = `Context: ${pack.totalTokens}/${pack.budget} tokens`;
  card.appendChild(head);
  for (const item of pack.items) {
    const row = document.createElement('div');
    row.className = 'ctx-row';
    const file = document.createElement('span');
    file.className = 'ctx-file';
    file.textContent = `${item.path}:${item.startLine}-${item.endLine}`;
    const reason = document.createElement('span');
    reason.className = 'ctx-reason';
    reason.textContent = item.reason;
    reason.title = item.reason;
    const tokens = document.createElement('span');
    tokens.className = 'ctx-tokens';
    tokens.textContent = `${item.tokens}t`;
    row.append(file, reason, tokens);
    card.appendChild(row);
  }
}

function openHistoryList(items: Array<{ id: string; startedAt: number; title: string }>): void {
  overlay.textContent = '';
  const back = document.createElement('button');
  back.id = 'overlayBack';
  back.textContent = '← Back';
  back.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.appendChild(back);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No saved chats yet.';
    overlay.appendChild(empty);
  }
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'hist-item';
    const when = new Date(item.startedAt).toLocaleString();
    div.innerHTML = '';
    const title = document.createElement('div');
    title.textContent = item.title;
    const date = document.createElement('div');
    date.className = 'hist-when';
    date.textContent = when;
    div.append(title, date);
    div.addEventListener('click', () => vscode.postMessage({ type: 'historyOpen', chatId: item.id }));
    overlay.appendChild(div);
  }
  overlay.classList.add('open');
}

function openHistoryTranscript(events: TranscriptItem[]): void {
  overlay.textContent = '';
  const back = document.createElement('button');
  back.id = 'overlayBack';
  back.textContent = '← Back';
  back.addEventListener('click', () => vscode.postMessage({ type: 'historyList' }));
  overlay.appendChild(back);
  const body = document.createElement('div');
  overlay.appendChild(body);
  const renderer = createRenderer(body);
  for (const event of events) {
    renderer.append(event);
  }
  overlay.classList.add('open');
}

window.addEventListener('message', (event: MessageEvent<Inbound>) => {
  const message = event.data;
  if (message.type === 'transcriptBatch') {
    for (const item of message.events ?? []) {
      live.append(item);
    }
    scrollBottom();
  } else if (message.type === 'contextCard' && message.pack) {
    renderCard(message.pack);
  } else if (message.type === 'cleared') {
    live.clear();
    card.innerHTML = '<span class="ctx-empty">Context will appear here.</span>';
  } else if (message.type === 'runState') {
    sendButton.disabled = message.running ?? false;
    sendButton.textContent = message.running ? 'Running…' : 'Send';
  } else if (message.type === 'mentionResults') {
    renderComplete((message.items ?? []) as string[]);
  } else if (message.type === 'historyList') {
    openHistoryList((message.items ?? []) as Array<{ id: string; startedAt: number; title: string }>);
  } else if (message.type === 'historyOpened') {
    openHistoryTranscript(message.events ?? []);
  }
});

function renderComplete(items: string[]): void {
  complete.textContent = '';
  if (items.length === 0) {
    complete.style.display = 'none';
    return;
  }
  complete.style.display = 'block';
  for (const item of items) {
    const div = document.createElement('div');
    div.textContent = item;
    div.addEventListener('click', () => {
      promptBox.value = promptBox.value.replace(/(?:^|\s)@(file|symbol)\s+[^\s@]*$/, ` @$1 ${item} `);
      complete.style.display = 'none';
      promptBox.focus();
    });
    complete.appendChild(div);
  }
}
