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

const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
/** Python classes longer than this are split into a header plus one chunk per method. */
const CLASS_SPLIT_LINES = 40;
const TS_DEF =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_][A-Za-z0-9_]*)|class\s+([A-Za-z_][A-Za-z0-9_]*)|(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=)/;
const MD_HEADING = /^(#{1,6})\s+(.+)/;
const RST_UNDERLINE = /^([=\-~^+#*]{3,})\s*$/;

function docstring(lines: string[], from: number): string | undefined {
  for (let i = from; i < Math.min(from + 4, lines.length); i++) {
    const line = lines[i].trim();
    const match = line.match(/^(?:"""|'''|"(?!")|'(?!'))(.{0,160})/);
    if (match) {
      // One-line docstrings carry their closing quotes; drop them.
      return match[1].replace(/("""|'''|"|')\s*$/, '').trim() || undefined;
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
    return chunkPython(relPath, lines);
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return chunkCode(relPath, lines, TS_DEF);
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
  defLine = start,
): Chunk {
  const text = lines.slice(start, end).join('\n');
  return {
    id: `${relPath}:${start + 1}-${end}`,
    path: relPath,
    startLine: start + 1,
    endLine: end,
    symbol,
    kind,
    signature: (lines[defLine] ?? '').trim().slice(0, 200),
    doc: docstring(lines, defLine + 1),
    text,
    tokens: estimateTokens(text),
  };
}

/** First line of the decorator block directly above `defLine` (same indent). */
function decoratorStart(lines: string[], defLine: number, floor: number): number {
  const indent = (lines[defLine].match(/^\s*/) ?? [''])[0];
  let start = defLine;
  while (start - 1 > floor && lines[start - 1].startsWith(`${indent}@`)) {
    start--;
  }
  return start;
}

interface PyStart {
  /** First line of the chunk (decorators included). */
  line: number;
  /** The def/class line itself. */
  defLine: number;
  symbol: string;
  kind: Chunk['kind'];
}

/**
 * Python: split at top-level def/class, decorators attached to the
 * definition they decorate. Long classes become a header chunk (class
 * line, docstring, attributes) plus one `Class.method` chunk per method,
 * so a single large class never swamps the budget or hides its methods
 * from search.
 */
function chunkPython(relPath: string, lines: string[]): Chunk[] {
  const starts: PyStart[] = [];
  lines.forEach((line, i) => {
    const match = line.match(PY_DEF);
    if (!match || match[1].length !== 0) {
      return;
    }
    starts.push({
      line: decoratorStart(lines, i, starts.length ? starts[starts.length - 1].defLine : -1),
      defLine: i,
      symbol: match[3],
      kind: match[2] === 'class' ? 'class' : 'function',
    });
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
    const s = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    if (s.kind === 'class' && end - s.line > CLASS_SPLIT_LINES) {
      out.push(...splitClass(relPath, lines, s, end));
    } else {
      out.push(makeChunk(relPath, lines, s.line, end, s.symbol, s.kind, s.defLine));
    }
  }
  return out;
}

/** Header chunk plus one chunk per first-level method of a long class. */
function splitClass(relPath: string, lines: string[], cls: PyStart, end: number): Chunk[] {
  const methods: PyStart[] = [];
  let bodyIndent: string | undefined;
  for (let i = cls.defLine + 1; i < end; i++) {
    const match = lines[i].match(PY_DEF);
    if (!match || match[2] !== 'def' || match[1].length === 0) {
      continue;
    }
    bodyIndent ??= match[1];
    if (match[1] !== bodyIndent) {
      continue; // nested function inside a method
    }
    const floor = methods.length ? methods[methods.length - 1].defLine : cls.defLine;
    methods.push({
      line: decoratorStart(lines, i, floor),
      defLine: i,
      symbol: `${cls.symbol}.${match[3]}`,
      kind: 'function',
    });
  }
  if (methods.length === 0) {
    return [makeChunk(relPath, lines, cls.line, end, cls.symbol, 'class', cls.defLine)];
  }
  const out = [
    makeChunk(relPath, lines, cls.line, methods[0].line, cls.symbol, 'class', cls.defLine),
  ];
  for (let k = 0; k < methods.length; k++) {
    const m = methods[k];
    const mEnd = k + 1 < methods.length ? methods[k + 1].line : end;
    out.push(makeChunk(relPath, lines, m.line, mEnd, m.symbol, m.kind, m.defLine));
  }
  return out;
}

/**
 * TS/JS module-level split: a chunk starts at each top-level definition
 * and runs to the next one. Files without definitions become one chunk.
 */
function chunkCode(relPath: string, lines: string[], pattern: RegExp): Chunk[] {
  const starts: Array<{ line: number; symbol: string; kind: Chunk['kind'] }> = [];
  lines.forEach((line, i) => {
    const match = line.match(pattern);
    if (!match) {
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
