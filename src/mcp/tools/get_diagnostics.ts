import { z } from 'zod';
import type { McpToolDef } from '../server';

export interface DiagnosticItem {
  path: string;
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

/** Injected by the extension host; plain-Node tests pass a stub. */
export type DiagnosticsProvider = (relPath?: string) => DiagnosticItem[];

export const getDiagnosticsSchema = z.object({
  path: z.string().optional().describe('Workspace-relative file, or the whole workspace.'),
});

export function makeGetDiagnostics(provider: DiagnosticsProvider): McpToolDef {
  return {
    name: 'get_diagnostics',
    description: 'Errors and warnings from VS Code for a file or the workspace.',
    inputSchema: getDiagnosticsSchema.shape,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      try {
        const parsed = getDiagnosticsSchema.parse(args);
        const items = provider(parsed.path);
        if (items.length === 0) {
          return { content: [{ type: 'text', text: 'No diagnostics.' }] };
        }
        const text = items
          .slice(0, 100)
          .map((item) => `${item.path}:${item.line}: ${item.severity}: ${item.message}`)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}
