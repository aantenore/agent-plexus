import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defineAdapter,
  PORT_VERSIONS,
  RUN_STATUSES,
  type AdapterContext,
  type AgentEntry,
  type Attrs,
  type MemberCallContext,
  type MemberPort,
  type MemberResult,
  type RunInput,
  type Skill,
} from '@agent-plexus/core';

/** The function a member wraps. It returns the answer text, or a full result to report a status. */
export type MemberFunction = (input: RunInput, ctx: MemberCallContext) => string | MemberResult | Promise<string | MemberResult>;

export interface SkillOption {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
}

export interface FunctionMemberOptions {
  /** `"<path>#<export>"`, the path relative to the system config directory. Without `#<export>`, the default export. */
  module?: string;
  /** The function itself, for tests and programmatic use. Takes the place of `module`. */
  fn?: MemberFunction;
  /** Display name; defaults to the member id. */
  name?: string;
  description?: string;
  skills?: SkillOption[];
  /** Used as the tags of one skill when `skills` is not set. */
  tags?: string[];
  attrs?: Attrs;
  audience?: string;
}

const DEFAULT_SKILL_ID = 'default';

function parseModuleRef(ref: string): { path: string; exportName: string } {
  const at = ref.lastIndexOf('#');
  const path = at < 0 ? ref : ref.slice(0, at);
  const exportName = at < 0 ? 'default' : ref.slice(at + 1);
  if (!path || !exportName) throw new TypeError(`function-member: module "${ref}" must look like "<path>#<export>"`);
  return { path, exportName };
}

async function loadFunction(ref: string, cwd: string): Promise<MemberFunction> {
  const { path, exportName } = parseModuleRef(ref);
  const file = isAbsolute(path) ? path : resolve(cwd, path);
  const mod: Record<string, unknown> = await import(pathToFileURL(file).href);
  const fn = Object.hasOwn(mod, exportName) ? mod[exportName] : undefined;
  if (typeof fn !== 'function') throw new TypeError(`function-member: export "${exportName}" of "${path}" is not a function`);
  return fn as MemberFunction;
}

function buildSkills(name: string, description: string, options: FunctionMemberOptions): Skill[] {
  if (options.skills?.length) {
    return options.skills.map((s) => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? '', tags: [...(s.tags ?? [])] }));
  }
  if (options.tags?.length) return [{ id: DEFAULT_SKILL_ID, name, description, tags: [...options.tags] }];
  return [];
}

/** Checks what the function returned and turns a bare string into a completed result. */
export function toMemberResult(value: unknown): MemberResult {
  if (typeof value === 'string') return { status: 'completed', output: value };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('function-member: the function must return a string or a MemberResult');
  }
  const result = value as MemberResult;
  if (!(RUN_STATUSES as readonly string[]).includes(result.status)) {
    throw new TypeError(`function-member: result status must be one of ${RUN_STATUSES.join(', ')}`);
  }
  if (typeof result.output !== 'string') throw new TypeError('function-member: result output must be a string');
  if (result.status !== 'completed' && !result.reason) return { ...result, reason: { code: 'error' } };
  return result;
}

const aborted = (name: string): MemberResult => ({ status: 'stopped', output: '', reason: { code: 'aborted', layer: 'member', by: name } });

/** Member that calls a function in process. `ctx` needs only the member id and the config directory. */
export async function createFunctionMember(options: FunctionMemberOptions, ctx: Pick<AdapterContext, 'name' | 'cwd'>): Promise<MemberPort> {
  const { name: id, cwd } = ctx;
  if (options.fn !== undefined && typeof options.fn !== 'function') throw new TypeError('function-member: fn must be a function');
  if (options.module !== undefined && typeof options.module !== 'string') throw new TypeError('function-member: module must be a string');
  if (!options.fn && !options.module) throw new TypeError('function-member: set module or fn');
  const fn = options.fn ?? (await loadFunction(options.module as string, cwd));
  const displayName = options.name ?? id;
  const description = options.description ?? '';

  return {
    name: id,
    describe: async () => {
      const entry: AgentEntry = {
        id,
        name: displayName,
        description,
        skills: buildSkills(displayName, description, options),
        endpoint: options.module ? { protocol: 'function', ref: options.module } : { protocol: 'function' },
        trust: { signed: false, pinned: true },
      };
      if (options.audience !== undefined) entry.audience = options.audience;
      if (options.attrs !== undefined) entry.attrs = { ...options.attrs };
      return entry;
    },
    async invoke(input, call) {
      const signal = call.signal;
      if (signal?.aborted) return aborted(id);
      const running = Promise.resolve().then(() => fn(input, call));
      if (!signal) return toMemberResult(await running);
      let onAbort: (() => void) | undefined;
      const stop = new Promise<'aborted'>((done) => {
        onAbort = () => done('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const outcome = await Promise.race([running, stop]);
        return outcome === 'aborted' ? aborted(id) : toMemberResult(outcome);
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

export const adapter = defineAdapter<'MemberPort', FunctionMemberOptions>({
  fills: 'MemberPort',
  name: 'function-member',
  maps: { technology: 'in-process function' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype', 'production'],
  description: 'Calls a function in process as a member; the function returns text or a full member result.',
  optionsSchema: {
    type: 'object',
    properties: {
      module: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      skills: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            name: { type: 'string' },
            description: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      tags: { type: 'array', items: { type: 'string' } },
      attrs: { type: 'object' },
      audience: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createFunctionMember(options, ctx),
});

export const adapters = [adapter];
