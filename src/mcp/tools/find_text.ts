import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { McpToolDef, TextResult } from '../server';
import { listFiles } from '../../context/files';
import { JailError } from './jail';

const MAX_MATCHES = 100;

export const findTextSchema = z.object({
  pattern: z.string().describe('JavaScript regex searched line by line. Empty lists files.'),
  glob: z
    .string()
    .optional()
    .describe('Substring filter on the file path, e.g. "src/" or ".py".'),
});

export type FindTextArgs = z.infer<typeof findTextSchema>;

function matchesGlob(relPath: string, glob: string | undefined): boolean {
  if (!glob) {
    return true;
  }
  // Simple substring semantics cover the model's needs without a matcher dep.
  return relPath.includes(glob.replace(/\*/g, ''));
}

/** Regex search over jailed files. Exported for direct unit testing. */
export async function findTextLines(
  rootDir: string,
  args: FindTextArgs,
): Promise<string> {
  const files = listFiles(rootDir).filter((file) => matchesGlob(file, args.glob));
  if (!args.pattern) {
    const shown = files.slice(0, MAX_MATCHES);
    const note =
      files.length > shown.length ? `\n… ${files.length - shown.length} more files.` : '';
    return `Files (${files.length}):\n${shown.join('\n')}${note}`;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch {
    throw new JailError(`Invalid regex: ${args.pattern}`);
  }
  const hits: string[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(rootDir, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    }
    if (hits.length >= MAX_MATCHES) {
      break;
    }
  }
  if (hits.length === 0) {
    return 'No matches.';
  }
  const note =
    hits.length >= MAX_MATCHES ? '\n… capped at 100 matches; narrow the pattern or glob.' : '';
  return `${hits.join('\n')}${note}`;
}

export function makeFindText(rootDir: string): McpToolDef {
  return {
    name: 'find_text',
    description: 'Regex-search workspace files. Empty pattern lists files for the glob.',
    inputSchema: findTextSchema.shape,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      try {
        const parsed = findTextSchema.parse(args);
        const text = await findTextLines(rootDir, parsed);
        return { content: [{ type: 'text', text }] } satisfies TextResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}
