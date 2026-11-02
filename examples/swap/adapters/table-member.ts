import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  defineAdapter, inputText, PORT_VERSIONS,
  type AdapterContext, type MemberPort, type MemberResult,
} from '@agent-plexus/core';

export interface TableMemberOptions {
  /** JSON file with `{ "rules": [...], "default": "..." }`, relative to the system config directory. */
  table: string;
  /** What the member does; the router and the registry read it. */
  description?: string;
}

/** One rule: when the request contains any of `words`, answer `output`, or stop with the code `stop`. */
interface Rule {
  words: string[];
  output?: string;
  stop?: string;
}

interface Table {
  rules: Rule[];
  default: string;
}

const NAME = 'table-member';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads and checks the table; a missing or malformed file is an error naming the file. */
async function readTable(path: string): Promise<Table> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`${NAME}: cannot read ${path}: ${(err as Error).message}`);
  }
  if (!isObject(doc) || !Array.isArray(doc.rules) || typeof doc.default !== 'string') throw new TypeError(`${NAME}: ${path} must hold { "rules": [...], "default": "<text>" }`);
  doc.rules.forEach((rule, i) => {
    const ok = isObject(rule) && Array.isArray(rule.words) && rule.words.every((w) => typeof w === 'string' && w)
      && (typeof rule.output === 'string') !== (typeof rule.stop === 'string');
    if (!ok) throw new TypeError(`${NAME}: ${path} rules[${i}] needs "words" and exactly one of "output" or "stop"`);
  });
  return doc as unknown as Table;
}

/** Member that answers from a rule table: the first rule with a word in the request answers, else the default. */
export async function createTableMember(options: TableMemberOptions, ctx: Pick<AdapterContext, 'name' | 'cwd'>): Promise<MemberPort> {
  const table = await readTable(resolve(ctx.cwd, options.table));
  return {
    name: ctx.name,
    describe: async () => ({
      id: ctx.name,
      name: ctx.name,
      description: options.description ?? '',
      skills: [],
      endpoint: { protocol: 'function', ref: options.table },
      trust: { signed: false, pinned: true },
    }),
    async invoke(input, call): Promise<MemberResult> {
      if (call.signal?.aborted) return { status: 'stopped', output: '', reason: { code: 'aborted', layer: 'member', by: ctx.name } };
      const text = inputText(input).toLowerCase();
      const rule = table.rules.find((r) => r.words.some((word) => text.includes(word.toLowerCase())));
      if (rule?.stop !== undefined) return { status: 'stopped', output: '', reason: { code: rule.stop, layer: 'member', by: ctx.name } };
      return { status: 'completed', output: rule?.output ?? table.default };
    },
  };
}

export const adapter = defineAdapter<'MemberPort', TableMemberOptions>({
  fills: 'MemberPort',
  name: NAME,
  maps: { technology: 'JSON rule table' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype'],
  capabilities: { waits: false, resume: false, cancel: false, checkpoint: false },
  description: 'Answers from a JSON table of keyword rules, without code: the first rule with a word in the request answers.',
  optionsSchema: {
    type: 'object',
    required: ['table'],
    properties: { table: { type: 'string', minLength: 1 }, description: { type: 'string' } },
    additionalProperties: false,
  },
  create: (options, ctx) => createTableMember(options, ctx),
});

export const adapters = [adapter];
