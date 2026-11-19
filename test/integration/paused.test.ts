import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { TrueForgeClient } from '../../src/trueforge/client';

/**
 * A paused turn waits on the user review, which has no time bound: when
 * the stream ends mid-pause the client must keep resubscribing instead
 * of failing into a retry. A stub TrueForge scripted below ends the
 * stream repeatedly before the turn finishes.
 */
describe('paused turn patience', { timeout: 120_000 }, () => {
  let server: http.Server | undefined;
  let baseUrl = '';
  let subscribes = 0;
  const approvals: unknown[] = [];

  function sse(res: http.ServerResponse, frames: string[]): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const frame of frames) {
      res.write(`data: ${frame}\n\n`);
    }
    res.end();
  }

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/v1/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":{"id":"s1"}}');
      } else if (req.method === 'POST' && url.pathname === '/api/v1/sessions/s1/turns') {
        sse(res, [
          '{"type":"turn.created","id":"e0","turn_id":"t1"}',
          '{"type":"tool.approval_required","id":"e1","thread_id":"main","tool_calls":[]}',
          '{"type":"turn.update","id":"e2","state":{"status":"paused"}}',
        ]);
      } else if (req.method === 'GET' && url.pathname === '/api/v1/sessions/s1/turns/t1/subscribe') {
        subscribes += 1;
        if (subscribes <= 8) {
          sse(res, []);
        } else {
          sse(res, ['{"type":"turn.done","id":"e9","state":{"status":"done"}}']);
        }
      } else if (req.method === 'POST' && url.pathname === '/api/v1/sessions/s1/turns/t1/events') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          approvals.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        });
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server?.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('waits through empty resubscribes while paused', async () => {
    const client = new TrueForgeClient(baseUrl);
    const sessionId = await client.createSession({ model: { name: 'm/x' } });
    assert.equal(sessionId, 's1');
    const terminal = await client.streamTurn(sessionId, 'hi', () => undefined);
    assert.equal(terminal.status, 'done');
    assert.ok(subscribes >= 8, `expected 8+ subscribes, got ${subscribes}`);
  });
});
