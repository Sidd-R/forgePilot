import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

/** Tool result shape. ForgePilot tools return text content only. */
export type TextResult = CallToolResult;

export type ToolHandler = (args: Record<string, unknown>) => Promise<TextResult>;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema?: ZodRawShape;
  annotations?: ToolAnnotations;
  handler: ToolHandler;
}

export interface McpEndpointDef {
  /** Server name, e.g. `forge-editor`. Served at `/<name>/mcp`. */
  name: string;
  tools: McpToolDef[];
}

export interface McpServerOptions {
  port: number;
  /** Bearer token TrueForge must send on every request. */
  token: string;
  endpoints: McpEndpointDef[];
}

export interface RunningMcpServer {
  port: number;
  urlFor: (endpoint: string) => string;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Local MCP server. Binds strictly to 127.0.0.1, checks a per-session
 * bearer token on every request, and serves one Streamable HTTP endpoint
 * per configured server name. No `vscode` dependency.
 */
export async function startMcpServer(
  options: McpServerOptions,
): Promise<RunningMcpServer> {
  const endpoints = new Map<string, McpEndpointDef>();
  for (const endpoint of options.endpoints) {
    endpoints.set(`/${endpoint.name}/mcp`, endpoint);
  }

  // A fresh server + transport per request: the SDK transport holds
  // per-request state and answers 500 when reused. Registration is cheap.
  async function handle(
    endpoint: McpEndpointDef,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const server = new McpServer({ name: endpoint.name, version: '0.0.1' });
    for (const tool of endpoint.tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
        async (args) => tool.handler(args as Record<string, unknown>),
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const endpoint = req.url
          ? endpoints.get(req.url.split('?')[0])
          : undefined;
        if (!endpoint || (req.method !== 'POST' && req.method !== 'GET')) {
          res.writeHead(404).end('not found');
          return;
        }
        if (req.headers.authorization !== `Bearer ${options.token}`) {
          res.writeHead(401).end('unauthorized');
          return;
        }
        await handle(endpoint, req, res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(400).end('bad request');
        }
      }
    })();
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  // Track sockets: TrueForge holds SSE streams open, and close() would
  // wait for them forever. Destroying them ends teardown promptly.
  const sockets = new Set<import('node:net').Socket>();
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    port,
    urlFor: (endpoint) => `http://127.0.0.1:${port}/${endpoint}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
