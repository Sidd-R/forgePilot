import type { TextEdit } from '../types';

/** Error the model can read and retry from. */
export class MatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchError';
  }
}

/** The file already holds the post-edit state; retrying is pointless. */
export class AlreadyAppliedError extends Error {
  constructor() {
    super(
      'No changes needed: the file already contains this exact edit. ' +
        'Reply with prose only, no tool call and no code block.',
    );
    this.name = 'AlreadyAppliedError';
  }
}

/** True when every edit's replacement is already present verbatim. */
export function isAlreadyApplied(fullText: string, edits: TextEdit[] | undefined): boolean {
  if (!edits || edits.length === 0) {
    return false;
  }
  return edits.every((edit) => edit.new_text !== '' && fullText.includes(edit.new_text));
}

export interface TextMatch {
  index: number;
  length: number;
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

/**
 * Locate `oldText` in `fullText`. Prefers a unique exact match, then a
 * unique whitespace-tolerant line match. Throws MatchError with the
 * nearest candidate window when nothing matches.
 */
export function findOldText(fullText: string, oldText: string): TextMatch {
  if (!oldText) {
    throw new MatchError('old_text is empty; quote the lines to replace.');
  }
  const first = fullText.indexOf(oldText);
  if (first >= 0) {
    if (fullText.indexOf(oldText, first + 1) === -1) {
      return { index: first, length: oldText.length };
    }
    throw new MatchError(
      'old_text matches more than once; include more surrounding lines to make it unique.',
    );
  }
  const hayLines = fullText.split('\n');
  const needleLines = oldText.split('\n').map(normalizeLine);
  const normHay = hayLines.map(normalizeLine);
  const hits: number[] = [];
  for (let i = 0; i + needleLines.length <= normHay.length; i++) {
    let ok = true;
    for (let k = 0; k < needleLines.length; k++) {
      if (normHay[i + k] !== needleLines[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      hits.push(i);
    }
  }
  if (hits.length === 1) {
    const offsets = lineStartOffsets(fullText);
    const start = offsets[hits[0]];
    const lastLine = hits[0] + needleLines.length - 1;
    const end = offsets[lastLine] + hayLines[lastLine].length;
    return { index: start, length: end - start };
  }
  if (hits.length > 1) {
    throw new MatchError(
      `old_text matches ${hits.length} similar regions; include more surrounding lines to make it unique.`,
    );
  }
  const candidate = nearestCandidate(hayLines, needleLines);
  throw new MatchError(
    `old_text did not match. Nearest candidate:\n${candidate}\n` +
      'Quote the file content exactly (indentation may differ slightly).',
  );
}

/** Apply search-and-replace edits in order. Throws MatchError. */
export function applyEditsToText(text: string, edits: TextEdit[] | undefined): string {
  let out = text;
  for (const edit of edits ?? []) {
    const match = findOldText(out, edit.old_text);
    out =
      out.slice(0, match.index) + edit.new_text + out.slice(match.index + match.length);
  }
  return out;
}

function tokens(line: string): Set<string> {
  return new Set(
    line
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean),
  );
}

/** Best same-size window by token overlap, returned as original lines. */
function nearestCandidate(hayLines: string[], needleLines: string[]): string {
  const needle = new Set<string>();
  for (const line of needleLines) {
    for (const token of tokens(line)) {
      needle.add(token);
    }
  }
  let best = 0;
  let bestScore = -1;
  const size = Math.max(1, needleLines.length);
  for (let i = 0; i < hayLines.length; i++) {
    const window = new Set<string>();
    for (let k = 0; k < size && i + k < hayLines.length; k++) {
      for (const token of tokens(hayLines[i + k])) {
        window.add(token);
      }
    }
    let score = 0;
    for (const token of window) {
      if (needle.has(token)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return hayLines.slice(best, best + size).join('\n');
}
