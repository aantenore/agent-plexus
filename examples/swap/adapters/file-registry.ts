import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  defineAdapter, PORT_VERSIONS,
  type AdapterContext, type AgentEntry, type CandidateFilter, type RegistryPort, type Skill,
} from '@agent-plexus/core';

export interface FileRegistryOptions {
  /** JSON file with `{ "agents": [...] }`, relative to the system config directory. */
  file?: string;
}

/** One agent as written in the file: only the id is required. */
interface FileAgent {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  skills?: { id: string; name?: string; description?: string; tags?: string[] }[];
  attrs?: AgentEntry['attrs'];
}

export const DEFAULT_FILE = './registry.json';

const NAME = 'file-registry';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toEntry(raw: unknown, where: string): AgentEntry {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) throw new TypeError(`${NAME}: ${where} needs a string id`);
  const agent = raw as unknown as FileAgent;
  const skills = (agent.skills ?? []).map((s, i): Skill => {
    if (!isObject(s) || typeof s.id !== 'string' || !s.id) throw new TypeError(`${NAME}: ${where}.skills[${i}] needs a string id`);
    return { id: s.id, name: s.name ?? s.id, description: s.description ?? '', tags: [...(s.tags ?? [])] };
  });
  return {
    id: agent.id,
    name: agent.name ?? agent.id,
    description: agent.description ?? '',
    skills,
    endpoint: { protocol: 'function' },
    trust: { signed: false, pinned: true },
    ...(agent.version !== undefined ? { version: agent.version } : {}),
    ...(agent.attrs !== undefined ? { attrs: { ...agent.attrs } } : {}),
  };
}

/** Reads the file and returns its entries; a missing or malformed file is an error naming the file. */
async function readEntries(path: string): Promise<AgentEntry[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`${NAME}: cannot read ${path}: ${(err as Error).message}`);
  }
  if (!isObject(doc) || !Array.isArray(doc.agents)) throw new TypeError(`${NAME}: ${path} must hold { "agents": [...] }`);
  const seen = new Set<string>();
  return doc.agents.map((raw, i) => {
    const entry = toEntry(raw, `agents[${i}]`);
    if (seen.has(entry.id)) throw new TypeError(`${NAME}: agents[${i}] repeats id "${entry.id}"`);
    seen.add(entry.id);
    return entry;
  });
}

function fits(entry: AgentEntry, filter: CandidateFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.skills?.length && !filter.skills.some((id) => entry.skills.some((s) => s.id === id))) return false;
  if (filter.tags?.length) {
    const tags = entry.skills.flatMap((s) => s.tags);
    if (!filter.tags.every((t) => tags.includes(t))) return false;
  }
  for (const [key, wanted] of Object.entries(filter.attrs ?? {})) {
    const have = entry.attrs?.[key];
    if (have === undefined) return false;
    const haveList = [have].flat();
    if (![wanted].flat().some((w) => haveList.includes(w))) return false;
  }
  return true;
}

/** Registry whose entries are the agents of a JSON file. The file is read on every call, so an edit shows at once. */
export function createFileRegistry(options: FileRegistryOptions, ctx: Pick<AdapterContext, 'name' | 'cwd'>): RegistryPort {
  const path = resolve(ctx.cwd, options.file ?? DEFAULT_FILE);
  return {
    name: ctx.name,
    list: async (filter) => (await readEntries(path)).filter((e) => fits(e, filter)),
    get: async (id) => (await readEntries(path)).find((e) => e.id === id),
  };
}

export const adapter = defineAdapter<'RegistryPort', FileRegistryOptions>({
  fills: 'RegistryPort',
  name: NAME,
  maps: { technology: 'JSON file of agent entries' },
  portVersion: PORT_VERSIONS.RegistryPort,
  tiers: ['prototype', 'production'],
  description: 'Lists the agents written in a JSON file, instead of the configured members.',
  optionsSchema: {
    type: 'object',
    properties: { file: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  create: (options, ctx) => createFileRegistry(options, ctx),
});

export const adapters = [adapter];
