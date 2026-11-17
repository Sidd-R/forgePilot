import * as fs from 'node:fs';
import { z } from 'zod';
import type { McpToolDef, TextResult } from '../server';
import { JailError, resolveInside } from './jail';

const MAX_LINES_PER_CALL = 400;

function textResult(text: string): TextResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): TextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export const readFileSchema = z.object({
  path: z.string().describe('Workspace-relative file path.'),
  start_line: z.number().int().min(1).optional().describe('1-based first line.'),
  end_line: z.number().int().min(1).optional().describe('1-based last line, inclusive.'),
});

export type ReadFileArgs = z.infer<typeof readFileSchema>;

/** Read a jailed file's text. Exported for direct unit testing. */
export async function readFileText(rootDir: string, args: ReadFileArgs): Promise<string> {
  const { abs, rel } = resolveInside(rootDir, args.path);
  let text: string;
  try {
    text = await fs.promises.readFile(abs, 'utf8');
  } catch {
    throw new JailError(`Cannot read ${rel}: no such file.`);
  }
  const lines = text.split('\n');
  const start = Math.max(1, args.start_line ?? 1);
  const end = Math.min(lines.length, args.end_line ?? lines.length);
  if (start > end) {
    return `${rel}: empty range (file has ${lines.length} lines).`;
  }
  const slice = lines.slice(start - 1, end);
  const capped = slice.slice(0, MAX_LINES_PER_CALL);
  const numbered = capped.map((line, i) => `${start + i}: ${line}`).join('\n');
  const note =
    slice.length > capped.length
      ? `\n… truncated to ${MAX_LINES_PER_CALL} lines; narrow start_line/end_line for more.`
      : '';
  return `${rel} (lines ${start}-${start + capped.length - 1} of ${lines.length}):\n${numbered}${note}`;
}

export function makeReadFile(rootDir: string): McpToolDef {
  return {
    name: 'read_file',
    description: 'Read workspace file content with line numbers, capped per call.',
    inputSchema: readFileSchema.shape,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      try {
        const parsed = readFileSchema.parse(args);
        return textResult(await readFileText(rootDir, parsed));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
