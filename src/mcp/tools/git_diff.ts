import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { McpToolDef } from '../server';
import { resolveInside } from './jail';

const MAX_DIFF_CHARS = 20000;

export const gitDiffSchema = z.object({
  path: z.string().optional().describe('Workspace-relative path to limit the diff.'),
});

function runGit(rootDir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', rootDir, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? `git diff unavailable: ${err.message.slice(0, 200)}` : stdout);
    });
  });
}

export function makeGitDiff(rootDir: string): McpToolDef {
  return {
    name: 'git_diff',
    description: 'Show the working-tree diff, truncated.',
    inputSchema: gitDiffSchema.shape,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      try {
        const parsed = gitDiffSchema.parse(args);
        const target = parsed.path ? [resolveInside(rootDir, parsed.path).rel] : [];
        const diff = await runGit(rootDir, ['diff', '--', ...target]);
        if (!diff.trim()) {
          return { content: [{ type: 'text', text: 'Working tree clean.' }] };
        }
        const text =
          diff.length > MAX_DIFF_CHARS
            ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… truncated; narrow path for more.`
            : diff;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}
