import type { ContextPack } from '../types';
import type { CodeIndex } from '../context/index';
import { resolveFileMention, resolveSymbolMention } from '../context/mentions';

/** Render the context pack as the model's leading input. */
export function renderPack(pack: ContextPack, prompt: string): string {
  const parts = [`[Context: ${pack.totalTokens} of ${pack.budget} tokens]`];
  for (const item of pack.items) {
    parts.push(
      `--- ${item.path}:${item.startLine}-${item.endLine} (${item.reason}, ${item.tokens}t) ---`,
    );
    parts.push(item.text);
  }
  if (pack.outline) {
    parts.push('--- repo outline ---');
    parts.push(pack.outline);
  }
  parts.push(`User request: ${prompt}`);
  return parts.join('\n');
}

const MENTION_PATTERN = /@(file|symbol)\s+([^\s@]+)/g;

/** Split @file/@symbol mentions out of a prompt, resolving each. */
export function parseMentions(
  index: CodeIndex,
  prompt: string,
): { files: string[]; symbols: string[]; clean: string } {
  const files: string[] = [];
  const symbols: string[] = [];
  const clean = prompt.replace(MENTION_PATTERN, (_match, kind, query) => {
    if (kind === 'file') {
      const hit = resolveFileMention(index, query)[0];
      if (hit) {
        files.push(hit);
        return hit;
      }
      return _match;
    }
    const hit = resolveSymbolMention(index, query)[0];
    if (hit) {
      symbols.push(hit.symbol);
      return hit.symbol;
    }
    return _match;
  });
  return { files, symbols, clean };
}
