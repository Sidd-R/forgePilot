/** DOM-free transcript assembly, shared by the webview and unit tests. */

export interface TranscriptItem {
  kind: string;
  text: string;
  id?: string;
  delta?: boolean;
}

export interface TranscriptLine {
  key: string;
  kind: string;
  /** Full assembled text for this line so far. */
  text: string;
  /** True the first time this line appears. */
  created: boolean;
}

/**
 * Merges streamed fragments by message id. Base messages arrive with
 * empty text and their content follows as deltas under the same id, so
 * every fragment must land on the visible line, never a scratch node.
 */
export class TranscriptStore {
  private texts = new Map<string, string>();
  private kinds = new Map<string, string>();
  private anon = 0;

  clear(): void {
    this.texts.clear();
    this.kinds.clear();
    this.anon = 0;
  }

  append(item: TranscriptItem): TranscriptLine {
    if (item.id) {
      const created = !this.texts.has(item.id);
      if (created) {
        this.kinds.set(item.id, item.kind);
      }
      this.texts.set(item.id, (this.texts.get(item.id) ?? '') + item.text);
      return {
        key: item.id,
        kind: this.kinds.get(item.id) ?? item.kind,
        text: this.texts.get(item.id) ?? '',
        created,
      };
    }
    this.anon += 1;
    return { key: `anon-${this.anon}`, kind: item.kind, text: item.text, created: true };
  }
}
