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
const spans = new Map<string, HTMLSpanElement>();
let queryId = 0;

function sendPrompt(): void {
  const text = promptBox.value.trim();
  if (!text) {
    return;
  }
  vscode.postMessage({ type: 'prompt', text });
  promptBox.value = '';
}

el('send').addEventListener('click', sendPrompt);
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

interface Inbound {
  type: string;
  events?: Array<{ kind: string; text: string; id?: string; delta?: boolean }>;
  pack?: {
    items: Array<{ path: string; startLine: number; endLine: number; reason: string; tokens: number }>;
    totalTokens: number;
    budget: number;
  };
  text?: string;
  running?: boolean;
  id?: number;
  items?: string[];
}

window.addEventListener('message', (event: MessageEvent<Inbound>) => {
  const message = event.data;
  if (message.type === 'transcriptBatch') {
    for (const item of message.events ?? []) {
      appendTranscript(item);
    }
  } else if (message.type === 'contextCard' && message.pack) {
    const lines = message.pack.items.map(
      (item) =>
        `${item.path}:${item.startLine}-${item.endLine} (${item.reason}, ${item.tokens}t)`,
    );
    card.textContent =
      `Context: ${message.pack.totalTokens}/${message.pack.budget} tokens\n${lines.join('\n')}`;
  } else if (message.type === 'notice' || message.type === 'status') {
    const div = document.createElement('div');
    div.textContent = message.text ?? '';
    log.appendChild(div);
  } else if (message.type === 'cleared') {
    log.textContent = '';
    card.textContent = 'Context will appear here.';
    spans.clear();
  } else if (message.type === 'runState') {
    el('send').textContent = message.running ? 'Running…' : 'Send';
  } else if (message.type === 'mentionResults') {
    renderComplete(message.items ?? []);
  }
});

function appendTranscript(item: { kind: string; text: string; id?: string; delta?: boolean }): void {
  if (item.delta && item.id) {
    const span = spans.get(item.id) ?? document.createElement('span');
    if (!spans.has(item.id)) {
      spans.set(item.id, span);
      const div = document.createElement('div');
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
  div.textContent = item.kind === 'text' ? item.text : `[${item.kind}] ${item.text}`;
  log.appendChild(div);
  if (item.id) {
    const span = document.createElement('span');
    spans.set(item.id, span);
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
