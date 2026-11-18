// Agent panel UI: prompt box with @ completion, context card, transcript.
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
const spans = new Map<string, HTMLSpanElement>();
let queryId = 0;

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
  events?: Array<{ kind: string; text: string; id?: string; delta?: boolean }>;
  pack?: { items: PackItem[]; totalTokens: number; budget: number };
  text?: string;
  running?: boolean;
  id?: number;
  items?: string[];
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

const KIND_CLASS: Record<string, string> = {
  text: 'msg',
  tool_call: 'msg msg-tool',
  tool_result: 'msg msg-tool',
  subagent: 'msg msg-tool',
  approval: 'msg msg-approval',
  status: 'msg msg-notice',
  notice: 'msg msg-notice',
};

window.addEventListener('message', (event: MessageEvent<Inbound>) => {
  const message = event.data;
  if (message.type === 'transcriptBatch') {
    for (const item of message.events ?? []) {
      appendTranscript(item);
    }
    scrollBottom();
  } else if (message.type === 'contextCard' && message.pack) {
    renderCard(message.pack);
  } else if (message.type === 'notice' || message.type === 'status') {
    const div = document.createElement('div');
    div.className = 'msg msg-notice';
    div.textContent = message.text ?? '';
    log.appendChild(div);
    scrollBottom();
  } else if (message.type === 'cleared') {
    log.textContent = '';
    card.innerHTML = '<span class="ctx-empty">Context will appear here.</span>';
    spans.clear();
  } else if (message.type === 'runState') {
    sendButton.disabled = message.running ?? false;
    sendButton.textContent = message.running ? 'Running…' : 'Send';
  } else if (message.type === 'mentionResults') {
    renderComplete(message.items ?? []);
  }
});

function appendTranscript(item: { kind: string; text: string; id?: string; delta?: boolean }): void {
  if (item.delta && item.id) {
    let span = spans.get(item.id);
    if (!span) {
      span = document.createElement('span');
      spans.set(item.id, span);
      const div = document.createElement('div');
      div.className = 'msg';
      div.appendChild(span);
      log.appendChild(div);
    }
    span.textContent += item.text;
    return;
  }
  if (item.id && spans.has(item.id)) {
    return;
  }
  const div = document.createElement('div');
  div.className = KIND_CLASS[item.kind] ?? 'msg';
  div.textContent = item.kind === 'text' ? item.text : `[${item.kind}] ${item.text}`;
  log.appendChild(div);
  if (item.id) {
    spans.set(item.id, document.createElement('span'));
  }
}

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
