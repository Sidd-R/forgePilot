/**
 * TrueForge setup helpers: register the local MCP servers and sync agent
 * definitions. Plain fetch, no SDK types needed.
 */

export interface McpRegistration {
  name: string;
  url: string;
  description: string;
  token: string;
}

async function checkOk(res: Response, action: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TrueForge ${action} failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Create or replace a remote MCP server registration in TrueForge. */
export async function registerMcpServer(
  baseUrl: string,
  reg: McpRegistration,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/settings/mcp-servers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      manifest: {
        type: 'remote',
        name: reg.name,
        url: reg.url,
        description: reg.description,
        auth: { type: 'header', headers: { Authorization: `Bearer ${reg.token}` } },
      },
    }),
  });
  await checkOk(res, `register MCP server ${reg.name}`);
}

/** Remove an MCP server registration. Missing names are ignored. */
export async function unregisterMcpServer(
  baseUrl: string,
  name: string,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/v1/settings/mcp-servers/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
  if (res.status === 404) {
    return;
  }
  await checkOk(res, `unregister MCP server ${name}`);
}
