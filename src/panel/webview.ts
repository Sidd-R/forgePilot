// Agent panel UI: header, context card, streamed transcript, composer.
import { createRenderer, type ToolTranscriptItem } from './render';
import { formatElapsed } from './present';
import { createCompletion } from './complete';

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

const scroller = el('scroll');
const empty = el('empty');
const promptBox = el<HTMLTextAreaElement>('prompt');
const complete = el('complete');
const sendButton = el<HTMLButtonElement>('send');
const working = el('working');
const workingText = el('workingText');
const overlay = el('overlay');
const sessionLink = el<HTMLAnchorElement>('sessionLink');
const undoButtons = [el<HTMLButtonElement>('undo1'), el<HTMLButtonElement>('undoRun')];
const openFile = (path: string, line: number): void => vscode.postMessage({ type: 'openFile', path, line });
const live = createRenderer(el('log'), openFile);
let running = false;
let startedAt = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let queryId = 0;
/** True between an approval pause and the next agent activity. */
let waitingOnUser = false;

interface Inbound {
  type: string;
  events?: ToolTranscriptItem[];
  running?: boolean;
  startedAt?: number;
  id?: number;
  items?: Array<string | { id: string; startedAt: number; title: string }>;
  model?: string;
  fallbacks?: string[];
  sessionUrl?: string;
  canUndo?: boolean;
}

/** Stick to the bottom only when the user has not scrolled up to read. */
function nearBottom(): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
}

function syncEmpty(): void {
  empty.style.display = live.isEmpty() ? 'block' : 'none';
}

function sendPrompt(): void {
  const text = promptBox.value.trim();
  if (!text || running) {
    return;
  }
  vscode.postMessage({ type: 'prompt', text });
  promptBox.value = '';
  completion.hide();
}

function setRunning(next: boolean, since: number): void {
  running = next;
  waitingOnUser = false;
  startedAt = since;
  sendButton.textContent = running ? 'Stop' : 'Send';
  sendButton.classList.toggle('stop', running);
  sendButton.title = running ? 'Cancel this run (pending edits are discarded)' : 'Send (Enter)';
  working.classList.toggle('show', running);
  promptBox.placeholder = running ? 'Agent is working… press Stop to cancel' : 'Describe a change…  (@file, @symbol)';
  clearInterval(ticker);
  if (running) {
    const tick = (): void => {
      const label = waitingOnUser ? 'Waiting for your review' : 'Working…';
      workingText.textContent = `${label} ${formatElapsed(Date.now() - startedAt)}`;
    };
    tick();
    ticker = setInterval(tick, 1000);
  }
}

sendButton.addEventListener('click', () => {
  if (running) {
    vscode.postMessage({ type: 'cancel' });
  } else {
    sendPrompt();
  }
});
el('undo1').addEventListener('click', () => vscode.postMessage({ type: 'undoLast' }));
el('undoRun').addEventListener('click', () => vscode.postMessage({ type: 'undoRun' }));
sessionLink.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
for (const example of Array.from(document.querySelectorAll<HTMLButtonElement>('.example'))) {
  example.addEventListener('click', () => {
    promptBox.value = example.dataset['prompt'] ?? '';
    promptBox.focus();
  });
}

const completion = createCompletion(promptBox, complete, (kind, query) => {
  queryId += 1;
  vscode.postMessage({ type: 'mentionQuery', kind, query, id: queryId });
});

promptBox.addEventListener('keydown', (event) => {
  if (completion.onKeydown(event)) {
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPrompt();
  }
});

// ---- history overlay ----
function overlayShell(onBack: () => void): HTMLElement {
  overlay.textContent = '';
  const back = document.createElement('button');
  back.className = 'link-btn';
  back.textContent = '← Back to chat';
  back.addEventListener('click', onBack);
  overlay.appendChild(back);
  overlay.classList.add('open');
  return overlay;
}

function openHistoryList(items: Array<{ id: string; startedAt: number; title: string }>): void {
  const root = overlayShell(() => overlay.classList.remove('open'));
  if (items.length === 0) {
    root.append(Object.assign(document.createElement('p'), { textContent: 'No saved chats yet. Chats are saved when you start a new one.' }));
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const title = document.createElement('div');
    title.textContent = item.title;
    const when = document.createElement('div');
    when.className = 'hist-when';
    when.textContent = new Date(item.startedAt).toLocaleString();
    row.append(title, when);
    row.addEventListener('click', () => vscode.postMessage({ type: 'historyOpen', chatId: item.id }));
    root.appendChild(row);
  }
}

function openHistoryTranscript(events: ToolTranscriptItem[]): void {
  const root = overlayShell(() => vscode.postMessage({ type: 'historyList' }));
  const body = document.createElement('div');
  body.className = 'hist-log';
  root.appendChild(body);
  const renderer = createRenderer(body, openFile);
  for (const event of events) {
    renderer.append(event);
  }
}

// ---- host messages ----
window.addEventListener('message', (event: MessageEvent<Inbound>) => {
  const message = event.data;
  if (message.type === 'transcriptBatch') {
    const stick = nearBottom();
    for (const item of message.events ?? []) {
      live.append(item);
      waitingOnUser = item.kind === 'approval' || (waitingOnUser && item.kind === 'review');
    }
    syncEmpty();
    if (stick) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  } else if (message.type === 'cleared') {
    live.clear();
    overlay.classList.remove('open');
    syncEmpty();
    promptBox.focus();
  } else if (message.type === 'runState') {
    setRunning(message.running ?? false, message.startedAt ?? Date.now());
  } else if (message.type === 'meta') {
    el('modelName').textContent = message.model || 'No model configured';
    el('modelDot').classList.toggle('off', !message.model);
    const fallbacks = message.fallbacks ?? [];
    el('fallbacks').textContent = fallbacks.length ? `+${fallbacks.length} fallback` : '';
    el('fallbacks').title = fallbacks.join('\n');
    sessionLink.style.display = message.sessionUrl ? 'inline' : 'none';
    sessionLink.title = message.sessionUrl ?? '';
    for (const button of undoButtons) {
      button.disabled = !message.canUndo;
    }
  } else if (message.type === 'mentionResults') {
    if (message.id === queryId) {
      completion.show((message.items ?? []) as string[]);
    }
  } else if (message.type === 'historyList') {
    openHistoryList((message.items ?? []) as Array<{ id: string; startedAt: number; title: string }>);
  } else if (message.type === 'historyOpened') {
    openHistoryTranscript(message.events ?? []);
  }
});

syncEmpty();
