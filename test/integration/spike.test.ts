import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startMcpServer } from '../../src/mcp/server';
import type { RunningMcpServer } from '../../src/mcp/server';
import { TrueForgeClient, approvalsOf } from '../../src/trueforge/client';
import {
  registerMcpServer,
  unregisterMcpServer,
} from '../../src/trueforge/setup';

const BASE_URL = process.env.FORGEPILOT_BASE_URL ?? 'http://localhost:8790';
const MODEL = 'muse/muse-spark-1-3-contributor';

/**
 * Architecture spike: a turn sent through the SDK calls our MCP tool over
 * HTTP on 127.0.0.1, pauses for approval, resumes on allow, and finishes.
 * Requires a local TrueForge with the muse provider configured.
 */
describe(
  'spike: MCP round trip through TrueForge',
  { timeout: 180_000 },
  () => {
    let server: RunningMcpServer | undefined;
    const calls: Array<Record<string, unknown>> = [];

    after(async () => {
      await unregisterMcpServer(BASE_URL, 'forge-spike').catch(() => undefined);
      await server?.close();
    });

    it('calls the tool, pauses for approval, resumes and finishes', async () => {
      server = await startMcpServer({
        port: 0,
        token: 'spike-token',
        endpoints: [
          {
            name: 'forge-spike',
            tools: [
              {
                name: 'spike_echo',
                description:
                  'Echo back the input text. Call this whenever the user asks to echo.',
                inputSchema: z.object({ text: z.string() }).shape,
                handler: (args) => {
                  calls.push(args);
                  return Promise.resolve({
                    content: [{ type: 'text', text: `echo:${args['text']}` }],
                  });
                },
              },
            ],
          },
        ],
      });
      await registerMcpServer(BASE_URL, {
        name: 'forge-spike',
        url: server.urlFor('forge-spike'),
        description: 'ForgePilot spike probe (deleted after the test)',
        token: 'spike-token',
      });

      const client = new TrueForgeClient(BASE_URL);
      await client.preflight();
      const sessionId = await client.createSession({
        model: { name: MODEL },
        instructions:
          'You have a tool spike_echo. When the user asks you to echo text, ' +
          'call spike_echo with that text, then reply with DONE.',
        mcp_servers: [
          {
            name: 'forge-spike',
            preload: true,
            require_approval_for_tools: ['spike_echo'],
          },
        ],
      });

      const seen: string[] = [];
      let approvals = 0;
      const terminal = await client.streamTurn(
        sessionId,
        'Echo the text hello-spike.',
        (event, cursor) => {
          seen.push(event.type);
          const pending = approvalsOf(event);
          if (pending.length === 0) {
            return;
          }
          approvals += pending.length;
          return (async () => {
            for (const approval of pending) {
              await client.answerApproval(
                sessionId,
                cursor.turnId,
                approval,
                true,
              );
            }
          })();
        },
      );

      assert.equal(terminal.status, 'done');
      assert.equal(approvals, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]['text'], 'hello-spike');
      assert.ok(seen.includes('turn.done'));
    });
  },
);
