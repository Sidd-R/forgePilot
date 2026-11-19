import type { TranscriptEvent } from '../types';

/** One saved chat: prompt title plus the raw transcript for replay. */
export interface ChatRecord {
  id: string;
  startedAt: number;
  title: string;
  events: TranscriptEvent[];
}

/** Minimal storage surface; the host adapts VS Code globalState to it. */
export interface ChatStorage {
  get(): ChatRecord[];
  set(records: ChatRecord[]): Promise<void> | void;
}

const MAX_RECORDS = 20;
const MAX_EVENTS_PER_CHAT = 1000;

/** Past-chat persistence with bounded growth. VS Code-free. */
export class ChatHistory {
  private current: ChatRecord | undefined;

  constructor(private readonly storage: ChatStorage) {}

  list(): Array<{ id: string; startedAt: number; title: string }> {
    return this.storage
      .get()
      .map((record) => ({ id: record.id, startedAt: record.startedAt, title: record.title }));
  }

  open(id: string): TranscriptEvent[] {
    return this.storage.get().find((record) => record.id === id)?.events ?? [];
  }

  /** Start (or continue) the live record with a prompt title. */
  beginPrompt(title: string): void {
    if (!this.current) {
      this.current = {
        id: `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        startedAt: Date.now(),
        title: title.slice(0, 80),
        events: [],
      };
    }
  }

  append(events: TranscriptEvent[]): void {
    if (!this.current || events.length === 0) {
      return;
    }
    const room = MAX_EVENTS_PER_CHAT - this.current.events.length;
    if (room > 0) {
      this.current.events.push(...events.slice(0, room));
    }
  }

  /** Raw events of the live (unfinalized) chat, for view rehydration. */
  liveEvents(): TranscriptEvent[] {
    return this.current ? [...this.current.events] : [];
  }

  /** Archive the live record and start fresh on the next prompt. */
  finalize(): void {
    if (this.current && this.current.events.length > 0) {
      const records = [this.current, ...this.storage.get()].slice(0, MAX_RECORDS);
      void this.storage.set(records);
    }
    this.current = undefined;
  }
}
