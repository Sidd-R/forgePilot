import * as path from 'node:path';

/** One retrievable unit: a function/class, doc section, or line window. */
export interface Chunk {
  id: string;
  /** Workspace-relative posix path. */
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  kind: 'function' | 'class' | 'section' | 'window';
  signature: string;
  doc?: string;
  text: string;
  tokens: number;
}

export interface SymbolEntry {
  symbol: string;
  path: string;
  startLine: number;
  endLine: number;
}

/** Token estimate used everywhere: 4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const PY_DEF = /^(\s*)(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const TS_DEF =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_][A-Za-z0-9_]*)|class\s+([A-Za-z_][A-Za-z0-9_]*)|(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=)/;
const MD_HEADING = /^(#{1,6})\s+(.+)/;
const RST_UNDERLINE = /^([=\-~^+#*]{3,})\s*$/;

function docstring(lines: string[], from: number): string | undefined {
  for (let i = from; i < Math.min(from + 4, lines.length); i++) {
    const line = lines[i].trim();
    const match = line.match(/^(?:"""|'''|"(?!")|'(?!'))(.{0,160})/);
    if (match) {
      return match[1].trim() || undefined;
    }
    if (line && !line.startsWith('#')) {
      return undefined;
    }
  }
  return undefined;
}

/** Split Python/TS/JS at module-level definitions, docs by heading. */
export function chunkFile(relPath: string, text: string): Chunk[] {
  const lines = text.split('\n');
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.md' || ext === '.rst' || ext === '.rst.txt') {
    return chunkDocs(relPath, lines);
  }
  if (ext === '.py' || ext === '.pyi') {
    return chunkCode(relPath, lines, PY_DEF, 2);
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return chunkCode(relPath, lines, TS_DEF, 0);
  }
  return chunkWindows(relPath, lines);
}

function makeChunk(
  relPath: string,
  lines: string[],
  start: number,
  end: number,
  symbol: string | undefined,
  kind: Chunk['kind'],
): Chunk {
  const text = lines.slice(start, end).join('\n');
  return {
    id: `${relPath}:${start + 1}-${end}`,
    path: relPath,
    startLine: start + 1,
    endLine: end,
    symbol,
    kind,
    signature: (lines[start] ?? '').trim().slice(0, 200),
    doc: docstring(lines, start + 1),
    text,
    tokens: estimateTokens(text),
  };
}

/**
 * Module-level split: a chunk starts at each top-level definition and
 * runs to the next one (Python methods stay inside their class chunk).
 * Files without definitions become one chunk.
 */
function chunkCode(
  relPath: string,
  lines: string[],
  pattern: RegExp,
  nameGroup: number,
): Chunk[] {
  const starts: Array<{ line: number; symbol: string; kind: Chunk['kind'] }> = [];
  lines.forEach((line, i) => {
    const match = line.match(pattern);
    if (!match) {
      return;
    }
    if (nameGroup > 0) {
      if (match[1].length !== 0) {
        return;
      }
      starts.push({
        line: i,
        symbol: match[nameGroup + 1],
        kind: match[2] === 'class' ? 'class' : 'function',
      });
      return;
    }
    const symbol = match[1] ?? match[2] ?? match[3] ?? 'anonymous';
    starts.push({ line: i, symbol, kind: match[2] ? 'class' : 'function' });
  });
  if (starts.length === 0) {
    return lines.length > 0
      ? [makeChunk(relPath, lines, 0, lines.length, undefined, 'window')]
      : [];
  }
  const out: Chunk[] = [];
  if (starts[0].line > 0) {
    out.push(makeChunk(relPath, lines, 0, starts[0].line, undefined, 'window'));
  }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    out.push(
      makeChunk(relPath, lines, starts[k].line, end, starts[k].symbol, starts[k].kind),
    );
  }
  return out;
}

function chunkDocs(relPath: string, lines: string[]): Chunk[] {
  const starts: Array<{ line: number; symbol: string }> = [];
  lines.forEach((line, i) => {
    const md = line.match(MD_HEADING);
    if (md) {
      starts.push({ line: i, symbol: md[2].slice(0, 120) });
      return;
    }
    if (i > 0 && RST_UNDERLINE.test(line) && lines[i - 1].trim()) {
      starts.push({ line: i - 1, symbol: lines[i - 1].trim().slice(0, 120) });
    }
  });
  if (starts.length === 0) {
    return chunkWindows(relPath, lines);
  }
  const out: Chunk[] = [];
  if (starts[0].line > 0) {
    out.push(makeChunk(relPath, lines, 0, starts[0].line, undefined, 'section'));
  }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    out.push(
      makeChunk(relPath, lines, starts[k].line, end, starts[k].symbol, 'section'),
    );
  }
  return out;
}

/** 60-line windows with 10 lines of overlap. */
export function chunkWindows(relPath: string, lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  const size = 60;
  const overlap = 10;
  for (let start = 0; start < lines.length; start += size - overlap) {
    const end = Math.min(start + size, lines.length);
    out.push(makeChunk(relPath, lines, start, end, undefined, 'window'));
    if (end >= lines.length) {
      break;
    }
  }
  return out;
}
