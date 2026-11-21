/** Pure selection -> edit-range rules for inline edit (no vscode import). */

export interface SymbolSpan {
  startLine: number;
  endLine: number;
  symbol?: string;
}

export interface SelectionInfo {
  /** 1-based lines. */
  startLine: number;
  endLine: number;
  empty: boolean;
  /** True when a single-line selection covers only part of that line (e.g. a name). */
  partial: boolean;
}

export interface TargetLines {
  startLine: number;
  endLine: number;
  /** Symbol the selection was widened to, if any. */
  expandedTo?: string;
}

/** Innermost named chunk that contains the whole line range. */
export function enclosingSymbol(
  spans: SymbolSpan[],
  startLine: number,
  endLine: number,
): SymbolSpan | undefined {
  let best: SymbolSpan | undefined;
  for (const span of spans) {
    if (!span.symbol || span.startLine > startLine || span.endLine < endLine) {
      continue;
    }
    if (!best || span.endLine - span.startLine < best.endLine - best.startLine) {
      best = span;
    }
  }
  return best;
}

/**
 * The lines an inline edit may change. A cursor, a selected name, or a
 * selected signature line widens to the enclosing function or class;
 * anything else the user selected is kept exactly.
 */
export function resolveTargetLines(sel: SelectionInfo, spans: SymbolSpan[]): TargetLines | undefined {
  const symbol = enclosingSymbol(spans, sel.startLine, sel.endLine);
  if (sel.empty) {
    return symbol ? { startLine: symbol.startLine, endLine: symbol.endLine, expandedTo: symbol.symbol } : undefined;
  }
  const singleLine = sel.startLine === sel.endLine;
  if (symbol && singleLine && (sel.partial || sel.startLine === symbol.startLine)) {
    return { startLine: symbol.startLine, endLine: symbol.endLine, expandedTo: symbol.symbol };
  }
  return { startLine: sel.startLine, endLine: sel.endLine };
}
