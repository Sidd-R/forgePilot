import { exec, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { McpToolDef } from '../server';

const MAX_OUTPUT_LINES = 200;

export const runCommandSchema = z.object({
  command: z.string().min(1).describe('Shell command run with the workspace as cwd.'),
  timeout_s: z.number().int().min(1).max(600).optional().describe('Timeout in seconds (default 120).'),
});

/** Runs shell commands; tracks the child so Cancel can kill it. */
export class CommandRunner {
  private current: ChildProcess | undefined;

  constructor(private readonly rootDir: string) {}

  kill(): void {
    this.current?.kill('SIGKILL');
    this.current = undefined;
  }

  run(command: string, timeoutS: number): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const child = exec(
        command,
        {
          cwd: this.rootDir,
          timeout: timeoutS * 1000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          this.current = undefined;
          const combined = `${stdout}${stderr}`;
          const lines = combined.split('\n');
          const tail = lines.slice(-MAX_OUTPUT_LINES).join('\n');
          const note =
            lines.length > MAX_OUTPUT_LINES ? `… showing last ${MAX_OUTPUT_LINES} lines.\n` : '';
          const timedOut = err?.killed === true;
          const code = timedOut ? 124 : typeof err?.code === 'number' ? err.code : err ? 1 : 0;
          resolve({
            exitCode: code,
            output: `${note}exit=${code}\n${tail}`.slice(0, 30000),
          });
        },
      );
      this.current = child;
    });
  }
}

export function makeRunCommand(runner: CommandRunner): McpToolDef {
  return {
    name: 'run_command',
    description: 'Run a shell command in the workspace. Returns exit code and output tail.',
    inputSchema: runCommandSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args) => {
      try {
        const parsed = runCommandSchema.parse(args);
        const result = await runner.run(parsed.command, parsed.timeout_s ?? 120);
        return { content: [{ type: 'text', text: result.output }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}
