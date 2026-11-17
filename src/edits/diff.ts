import type { Hunk } from '../types';

/** Gaps of this many unchanged lines or fewer merge adjacent changes. */
export const HUNK_MERGE_GAP = 3;

type RowKind = 'same' | 'del' | 'add';

interface Row {
  kind: RowKind;
  text: string;
}

/**
 * Myers line diff. Returns per-line rows in order. Files whose combined
 * line count exceeds the cap degrade to a single whole-file hunk.
 */
export function diffLines(a: string[], b: string[]): Row[] {
  if (a.length + b.length > 20000) {
    return [
      ...a.map((text): Row => ({ kind: 'del', text })),
      ...b.map((text): Row => ({ kind: 'add', text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const trace: Array<Map<number, number>> = [];
  let v = new Map<number, number>();
  v.set(1, 0);
  let found = false;
  for (let d = 0; d <= n + m && !found; d++) {
    const cur = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      const goDown =
        k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = goDown ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      cur.set(k, x);
      if (x >= n && y >= m) {
        found = true;
      }
    }
    v = cur;
    trace.push(cur);
  }
  const rows: Row[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const goDown =
      k === -d || (k !== d && (prev.get(k - 1) ?? -1) < (prev.get(k + 1) ?? -1));
    const prevK = goDown ? k + 1 : k - 1;
    const prevX = prev.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rows.push({ kind: 'same', text: a[x] });
    }
    if (x > prevX) {
      x--;
      rows.push({ kind: 'del', text: a[x] });
    } else if (y > prevY) {
      y--;
      rows.push({ kind: 'add', text: b[y] });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rows.push({ kind: 'same', text: a[x] });
  }
  // Leftover pure insertion or deletion at the start.
  while (x > 0) {
    x--;
    rows.push({ kind: 'del', text: a[x] });
  }
  while (y > 0) {
    y--;
    rows.push({ kind: 'add', text: b[y] });
  }
  rows.reverse();
  return rows;
}

/**
 * Group diff rows into hunks. Unchanged gaps of HUNK_MERGE_GAP lines or
 * fewer stay inside one hunk; longer gaps split it. Each hunk carries
 * original (1-based) coordinates plus both line variants.
 */
export function rowsToHunks(rows: Row[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let n = 0;
  // Original line number (1-based) of rows[i].
  let origLine = 1;
  const isChange = (r: Row): boolean => r.kind !== 'same';

  while (i < rows.length) {
    if (!isChange(rows[i])) {
      origLine++;
      i++;
      continue;
    }
    n++;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const startLine = origLine;
    let j = i;
    while (j < rows.length) {
      if (isChange(rows[j])) {
        if (rows[j].kind !== 'add') {
          oldLines.push(rows[j].text);
          origLine++;
        }
        if (rows[j].kind !== 'del') {
          newLines.push(rows[j].text);
        }
        j++;
        continue;
      }
      // Count the unchanged run to decide merge vs split.
      let run = 0;
      while (j + run < rows.length && !isChange(rows[j + run])) {
        run++;
      }
      const moreChanges = j + run < rows.length;
      if (moreChanges && run <= HUNK_MERGE_GAP) {
        for (let k = 0; k < run; k++) {
          oldLines.push(rows[j + k].text);
          newLines.push(rows[j + k].text);
          origLine++;
        }
        j += run;
        continue;
      }
      break;
    }
    hunks.push({ id: `h${n}`, startLine, oldLines, newLines });
    i = j;
  }
  return hunks;
}

/** Diff two file texts into review hunks. Empty diff yields no hunks. */
export function computeHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) {
    return [];
  }
  return rowsToHunks(diffLines(oldText.split('\n'), newText.split('\n')));
}

/**
 * Apply hunks to the original text. Hunks in `accepted` take their new
 * lines; the rest keep their old lines. Coordinates stay valid because
 * hunks are disjoint in original line space.
 */
export function applyHunks(
  oldText: string,
  hunks: Hunk[],
  accepted: ReadonlySet<string>,
): string {
  const lines = oldText.split('\n');
  const ordered = [...hunks].sort((p, q) => q.startLine - p.startLine);
  for (const hunk of ordered) {
    if (!accepted.has(hunk.id)) {
      continue;
    }
    lines.splice(hunk.startLine - 1, hunk.oldLines.length, ...hunk.newLines);
  }
  return lines.join('\n');
}
