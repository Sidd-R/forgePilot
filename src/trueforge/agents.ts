import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { WireAgentSpec } from './wire';

export interface AgentFile {
  name: string;
  description: string;
  manifest: WireAgentSpec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Load agents/<file> and stamp the model name in. Throws on missing fields
 * so a bad definition fails locally instead of at the API.
 */
export function loadAgentFile(
  agentsDir: string,
  file: string,
  modelName: string,
): AgentFile {
  const raw: unknown = parseYaml(
    fs.readFileSync(path.join(agentsDir, file), 'utf8'),
  );
  if (!isRecord(raw) || typeof raw['name'] !== 'string') {
    throw new Error(`Agent file ${file} has no name.`);
  }
  if (typeof raw['description'] !== 'string') {
    throw new Error(`Agent file ${file} has no description.`);
  }
  if (!isRecord(raw['manifest'])) {
    throw new Error(`Agent file ${file} has no manifest.`);
  }
  const manifest = raw['manifest'] as unknown as WireAgentSpec;
  manifest.model = { ...(manifest.model ?? {}), name: modelName };
  return {
    name: raw['name'],
    description: raw['description'],
    manifest,
  };
}

async function checkOk(res: Response, action: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TrueForge ${action} failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

/** Create the named agent, or update it when it already exists. */
export async function syncAgent(baseUrl: string, agent: AgentFile): Promise<void> {
  const listRes = await fetch(`${baseUrl}/api/v1/agents`);
  await checkOk(listRes, 'list agents');
  const list = (await listRes.json()) as {
    data: Array<{ id: string; name: string }>;
  };
  const existing = list.data.find((entry) => entry.name === agent.name);
  if (existing) {
    const res = await fetch(`${baseUrl}/api/v1/agents/${existing.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: agent.description,
        manifest: agent.manifest,
      }),
    });
    await checkOk(res, `update agent ${agent.name}`);
    return;
  }
  const res = await fetch(`${baseUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  });
  await checkOk(res, `create agent ${agent.name}`);
}
