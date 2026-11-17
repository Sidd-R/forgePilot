import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import MiniSearch from 'minisearch';
import type { Chunk, SymbolEntry } from './chunk';
import { chunkFile } from './chunk';
import { listFiles } from './files';

export type { Chunk, SymbolEntry } from './chunk';
export { chunkFile, chunkWindows, estimateTokens } from './chunk';
export { listFiles } from './files';

interface MiniDoc {
  id: string;
  name: string;
  signature: string;
  text: string;
  index: number;
}

function splitCodeWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

/** Lexical + symbol index with BM25 search over chunks. */
export class CodeIndex {
  readonly chunks: Chunk[] = [];
  readonly symbols = new Map<string, SymbolEntry[]>();
  /** file -> top-level symbol names. */
  readonly repoMap = new Map<string, string[]>();
  /** file -> files changed together, with commit counts. */
  cochange = new Map<string, Array<{ file: string; count: number }>>();
  private mini: MiniSearch<MiniDoc> | undefined;

  /** Build synchronously from disk; call loadCochange after for git data. */
  static build(rootDir: string): CodeIndex {
    const index = new CodeIndex();
    const docs: MiniDoc[] = [];
    for (const relPath of listFiles(rootDir)) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
      } catch {
        continue;
      }
      const names: string[] = [];
      for (const chunk of chunkFile(relPath, text)) {
        const idx = index.chunks.length;
        index.chunks.push(chunk);
        docs.push({
          id: chunk.id,
          name: splitCodeWords(`${chunk.symbol ?? ''} ${relPath}`),
          signature: splitCodeWords(chunk.signature),
          text: `${chunk.text.slice(0, 4000)} ${chunk.doc ?? ''}`.toLowerCase(),
          index: idx,
        });
        if (chunk.symbol) {
          names.push(chunk.symbol);
          const list = index.symbols.get(chunk.symbol) ?? [];
          list.push({
            symbol: chunk.symbol,
            path: relPath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          });
          index.symbols.set(chunk.symbol, list);
        }
      }
      if (names.length > 0) {
        index.repoMap.set(relPath, names);
      }
    }
    index.mini = new MiniSearch<MiniDoc>({
      fields: ['name', 'signature', 'text'],
      storeFields: ['index'],
      searchOptions: {
        boost: { name: 3, signature: 3 },
        prefix: true,
        combineWith: 'OR',
      },
    });
    index.mini.addAll(docs);
    return index;
  }

  /** BM25 matches for pre-tokenized query text. */
  search(query: string, limit = 30): Array<{ chunk: Chunk; score: number }> {
    if (!this.mini || !query.trim()) {
      return [];
    }
    return this.mini
      .search(query, { combineWith: 'OR', prefix: true })
      .slice(0, limit)
      .map((hit) => ({ chunk: this.chunks[hit.index], score: hit.score }));
  }

  /** Fill the co-change table from git history. Empty when not a repo. */
  async loadCochange(rootDir: string): Promise<void> {
    this.cochange = await readCochange(rootDir);
  }
}

function gitLog(rootDir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', rootDir, 'log', '--max-count=500', '--name-only', '--pretty=format:%nCOMMIT%n'],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });
}

export async function readCochange(
  rootDir: string,
): Promise<Map<string, Array<{ file: string; count: number }>>> {
  const raw = await gitLog(rootDir);
  const pairs = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string): void => {
    if (a === b) {
      return;
    }
    let row = pairs.get(a);
    if (!row) {
      row = new Map();
      pairs.set(a, row);
    }
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  for (const block of raw.split('\nCOMMIT\n')) {
    const files = [
      ...new Set(
        block
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('COMMIT')),
      ),
    ].slice(0, 20);
    for (const a of files) {
      for (const b of files) {
        bump(a, b);
      }
    }
  }
  const out = new Map<string, Array<{ file: string; count: number }>>();
  for (const [file, row] of pairs) {
    out.set(
      file,
      [...row.entries()]
        .map(([other, count]) => ({ file: other, count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, 10),
    );
  }
  return out;
}
