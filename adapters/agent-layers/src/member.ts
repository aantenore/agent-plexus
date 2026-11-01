import type { ComposeOptions, Stack } from '@agent-layers/core';
import { defineAdapter, inputText, PORT_VERSIONS } from '@agent-plexus/core';
import type { AdapterContext, AgentEntry, Attrs, MemberPort, Skill } from '@agent-plexus/core';
import { layersCaller, memberResultOf } from './map.ts';
import { openStack } from './stack.ts';

export interface SkillOption {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
}

export interface MemberOptions {
  /** Path of the agent-layers config, relative to the directory of the plexus config. */
  config: string;
  profile?: string;
  /** The agent of the stack that this member runs. */
  agent: string;
  description?: string;
  skills?: SkillOption[];
  /** Used as the tags of one skill when `skills` is not set. */
  tags?: string[];
  attrs?: Attrs;
  /** Credential audience. */
  audience?: string;
}

const PROTOCOL = 'agent-layers';
const DEFAULT_SKILL_ID = 'default';

function buildSkills(name: string, description: string, options: MemberOptions): Skill[] {
  if (options.skills?.length) {
    return options.skills.map((s) => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? '', tags: [...(s.tags ?? [])] }));
  }
  if (options.tags?.length) return [{ id: DEFAULT_SKILL_ID, name, description, tags: [...options.tags] }];
  return [];
}

/**
 * An agent of a composed stack as a member. In process there is no outbound hop: `ctx.outbound` is not passed on, and
 * the call is bounded only by the abort signal the pipeline gives it.
 */
export function memberFromStack(stack: Stack, options: MemberOptions, id: string): MemberPort {
  if (!stack.agents().includes(options.agent)) {
    throw new TypeError(`agent-layers: agent "${options.agent}" is not configured (known: ${stack.agents().join(', ') || 'none'})`);
  }
  const description = options.description ?? '';
  return {
    name: id,
    native: () => stack,
    async describe() {
      const entry: AgentEntry = {
        id,
        name: options.agent,
        description,
        skills: buildSkills(options.agent, description, options),
        endpoint: { protocol: PROTOCOL, ref: `${options.config}#${options.agent}` },
        trust: { signed: false, pinned: true },
      };
      if (options.audience !== undefined) entry.audience = options.audience;
      if (options.attrs !== undefined) entry.attrs = { ...options.attrs };
      return entry;
    },
    async invoke(input, call) {
      const caller = call.caller ? layersCaller(call.caller, call.credential) : undefined;
      const agent = await stack.agent(options.agent);
      const result = await agent.run(inputText(input), {
        ...(caller ? { caller } : {}),
        ...(call.sessionId ? { sessionId: call.sessionId } : {}),
        ...(call.signal ? { signal: call.signal } : {}),
        ...(call.trace ? { trace: call.trace } : {}),
      });
      return memberResultOf(result);
    },
  };
}

/** Composes the configured stack, one per member instance; closing the member closes the stack. */
export async function createMember(options: MemberOptions, ctx: Pick<AdapterContext, 'name' | 'cwd'>, composeOptions?: ComposeOptions): Promise<MemberPort & { close(): Promise<void> }> {
  const stack = await openStack(options, ctx.cwd, composeOptions);
  try {
    return { ...memberFromStack(stack, options, ctx.name), close: () => stack.close() };
  } catch (err) {
    await stack.close();
    throw err;
  }
}

export const memberAdapter = defineAdapter<'MemberPort', MemberOptions>({
  fills: 'MemberPort',
  name: 'agent-layers',
  maps: { technology: 'agent-layers stack' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype', 'production'],
  description: 'Runs an agent of a composed agent-layers stack as a member.',
  optionsSchema: {
    type: 'object',
    properties: {
      config: { type: 'string', minLength: 1 },
      profile: { type: 'string', minLength: 1 },
      agent: { type: 'string', minLength: 1 },
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
    required: ['config', 'agent'],
    additionalProperties: false,
  },
  create: (options, ctx) => createMember(options, ctx),
});
