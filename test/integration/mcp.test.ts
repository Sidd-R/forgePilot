import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMcpServer } from '../../src/mcp/server';
import type { RunningMcpServer } from '../../src/mcp/server';
import { makeReadFile } from '../../src/mcp/tools/read_file';

const TOKEN = 'mcp-test-token';
let root = '';
let server: RunningMcpServer | undefined;

async function rpc(url: string, body: unknown, token?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

describe('mcp http server', () => {
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpmcp-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    server = await startMcpServer({
      port: 0,
      token: TOKEN,
      endpoints: [{ name: 'forge-editor', tools: [makeReadFile(root)] }],
    });
  });

  after(async () => {
    await server?.close();
  });

  it('rejects requests without the bearer token', async () => {
    const url = server?.urlFor('forge-editor') ?? '';
    const res = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(res.status, 401);
    const wrong = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      'wrong',
    );
    assert.equal(wrong.status, 401);
  });

  it('serves initialize, tools/list, and tools/call', async () => {
    const url = server?.urlFor('forge-editor') ?? '';
    const init = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      TOKEN,
    );
    assert.equal(init.status, 200);
    assert.match(init.text, /forge-editor/);

    const list = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      TOKEN,
    );
    assert.equal(list.status, 200);
    assert.match(list.text, /read_file/);

    const call = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } },
      TOKEN,
    );
    assert.equal(call.status, 200);
    assert.match(call.text, /hello/);
  });

  it('enforces the path jail over the wire', async () => {
    const url = server?.urlFor('forge-editor') ?? '';
    const call = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '../../etc/passwd' } },
      },
      TOKEN,
    );
    assert.equal(call.status, 200);
    assert.match(call.text, /outside the workspace/);
  });
});
