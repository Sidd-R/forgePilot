import { z } from 'zod';
import type { McpToolDef } from '../server';
import type { CodeIndex } from '../../context/index';
import { estimateTokens } from '../../context/index';
import { tokenizeRequest } from '../../context/mentions';

export const searchCodeSchema = z.object({
  query: z.string().min(1).describe('Natural-language or keyword query.'),
  max_tokens: z.number().int().min(100).optional().describe('Result budget (default 2000).'),
});

/** Ranked chunk search over the same index that seeds context packs. */
export function makeSearchCode(getIndex: () => CodeIndex): McpToolDef {
  return {
    name: 'search_code',
    description: 'Search workspace code by meaning-ish keywords. Returns ranked chunks.',
    inputSchema: searchCodeSchema.shape,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      try {
        const parsed = searchCodeSchema.parse(args);
        const budget = parsed.max_tokens ?? 2000;
        const tokens = tokenizeRequest(parsed.query);
        const hits = getIndex().search(tokens.join(' '), 20);
        if (hits.length === 0) {
          return { content: [{ type: 'text', text: 'No matches.' }] };
        }
        const blocks: string[] = [];
        let used = 0;
        for (const hit of hits) {
          const chunk = hit.chunk;
          const header = `${chunk.path}:${chunk.startLine}-${chunk.endLine}` +
            `${chunk.symbol ? ` ${chunk.kind} ${chunk.symbol}` : ''} (score ${hit.score.toFixed(2)})`;
          const body = chunk.text.slice(0, 1500);
          const block = `${header}\n${body}`;
          const cost = estimateTokens(block);
          if (used + cost > budget) {
            break;
          }
          used += cost;
          blocks.push(block);
        }
        const text = blocks.length > 0 ? blocks.join('\n---\n') : 'No matches within budget.';
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}
