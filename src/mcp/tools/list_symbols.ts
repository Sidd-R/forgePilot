import { z } from 'zod';
import type { McpToolDef } from '../server';
import type { CodeIndex } from '../../context/index';
import { resolveInside } from './jail';

export const listSymbolsSchema = z.object({
  path: z.string().describe('Workspace-relative file path.'),
});

/** Functions and classes in one file, from the shared index. */
export function makeListSymbols(rootDir: string, getIndex: () => CodeIndex): McpToolDef {
  return {
    name: 'list_symbols',
    description: 'List functions and classes in a file with line ranges.',
    inputSchema: listSymbolsSchema.shape,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      try {
        const parsed = listSymbolsSchema.parse(args);
        const index = getIndex();
        const known = new Set(index.chunks.map((chunk) => chunk.path));
        const { rel } = resolveInside(rootDir, parsed.path);
        if (!known.has(rel) && ![...known].some((k) => k.endsWith(rel))) {
          return {
            content: [{ type: 'text', text: `No symbols indexed for ${rel}.` }],
          };
        }
        const rows = index.chunks
          .filter((chunk) => chunk.path === rel || chunk.path.endsWith(`/${rel}`))
          .filter((chunk) => chunk.symbol)
          .map(
            (chunk) =>
              `${chunk.kind} ${chunk.symbol} (lines ${chunk.startLine}-${chunk.endLine})`,
          );
        const text = rows.length > 0 ? rows.join('\n') : `No symbols in ${rel}.`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}
