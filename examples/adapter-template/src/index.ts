import {
  defineAdapter, defineLimits, inputText, PORT_VERSIONS,
  type AdapterContext, type AgentEntry, type MemberPort, type MemberResult,
} from '@agent-plexus/core';

/** Options, validated against `optionsSchema` (and the declared limits) before `create` runs. */
export interface TemplateOptions {
  /** Text put before the input in every answer. */
  greeting?: string;
  description?: string;
  /** Longest input answered; a longer one is refused. */
  maxInputChars?: number;
}

const NAME = 'template';

/**
 * Configurable limits: every timeout, size, count or truncation length is declared here once, never written as a
 * literal in the code, and has a row in docs/limits.md once the adapter is published.
 */
export const limits = defineLimits({
  maxInputChars: {
    path: 'options.maxInputChars',
    default: 10_000,
    unit: 'count',
    min: 1,
    integer: true,
    why: 'Longest input the member answers; a longer one is refused instead of being cut.',
  },
});

/** `ext` key the member writes on its results, in its own namespace (the adapter name). */
export const CHARS_KEY = `${NAME}.chars`;

const DEFAULT_GREETING = 'Hello';

/** Factory: usable from code without a system config. `ctx` needs only the member id. */
export function createTemplateMember(options: TemplateOptions, ctx: Pick<AdapterContext, 'name'>): MemberPort {
  const greeting = options.greeting ?? DEFAULT_GREETING;
  const maxInputChars = options.maxInputChars ?? limits.maxInputChars.default;
  if (typeof maxInputChars !== 'number' || !Number.isInteger(maxInputChars) || maxInputChars < limits.maxInputChars.min) throw new TypeError(`${NAME}: maxInputChars must be an integer of at least 1`);
  const id = ctx.name;
  return {
    name: id,
    async describe(): Promise<AgentEntry> {
      return {
        id,
        name: id,
        description: options.description ?? '',
        skills: [],
        endpoint: { protocol: 'function', ref: NAME },
        trust: { signed: false, pinned: true },
      };
    },
    async invoke(input, call): Promise<MemberResult> {
      // Problems are results, never exceptions: an abort, then a refused input.
      if (call.signal?.aborted) return { status: 'stopped', output: '', reason: { code: 'aborted', layer: 'member', by: id } };
      const text = inputText(input);
      if (text.length > maxInputChars) return { status: 'stopped', output: '', reason: { code: 'rejected', layer: 'member', by: id, detail: 'input too long' } };
      return { status: 'completed', output: `${greeting} ${text}`, ext: { [CHARS_KEY]: text.length } };
    },
  };
}

/** Descriptor: what the core and the CLI see. Name it after the standard or technology it maps. */
export const adapter = defineAdapter<'MemberPort', TemplateOptions>({
  fills: 'MemberPort',
  name: NAME,
  maps: { technology: 'fixed greeting' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype'],
  description: 'Skeleton member: answers every input with a fixed greeting.',
  // What the member does beyond describe and invoke; the readiness gate reads it.
  capabilities: { resume: false, cancel: false, checkpoint: false, waits: false },
  optionsSchema: {
    type: 'object',
    properties: {
      greeting: { type: 'string' },
      description: { type: 'string' },
      maxInputChars: { type: 'integer', minimum: limits.maxInputChars.min },
    },
    additionalProperties: false,
  },
  limits,
  create: (options, ctx) => createTemplateMember(options, ctx),
});

export const adapters = [adapter];
