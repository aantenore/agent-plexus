import * as layers from '@agent-layers/core';
import type { CallContext, Caller as LayersCaller, ComposeOptions, RunInput as LayersInput, RunResult, Stack } from '@agent-layers/core';
import { defineAdapter, inputText, PORT_VERSIONS } from '@agent-plexus/core';
import type { AdapterContext, AgentEntry, Attrs, MemberCallContext, MemberPort, MemberResult, RunInput, Skill } from '@agent-plexus/core';
import { delegationOf, layersCaller, memberResultOf, refusalKind, refusedResult } from './map.ts';
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
 * Run control of a stack (agent-layers 0.4.0 on), as far as a member uses it: continue a waiting run with the input it
 * waits for, cancel a run. Both are detected on the stack; an older stack has neither.
 */
interface RunControl {
  resume?(runId: string, answer: { input: LayersInput }, ctx?: Partial<CallContext>): Promise<RunResult>;
  cancel?(runId: string, opts?: { by?: LayersCaller; reason?: string; signal?: AbortSignal }): Promise<unknown>;
}

function runControlOf(stack: Stack): RunControl {
  const s = stack as Stack & RunControl;
  return {
    ...(typeof s.resume === 'function' ? { resume: s.resume.bind(stack) } : {}),
    ...(typeof s.cancel === 'function' ? { cancel: s.cancel.bind(stack) } : {}),
  };
}

/** True when the installed agent-layers composes stacks with run control: what the descriptor declares. */
const RUN_CONTROL = typeof (layers as unknown as Record<string, unknown>).RunRefused === 'function';

/** The run context of a member call: the caller (with the credential the pipeline gave), session, signal, trace, bounds. */
function runContext(call: MemberCallContext): Partial<CallContext> {
  const caller = call.caller ? layersCaller(call.caller, call.credential) : undefined;
  return {
    ...(caller ? { caller } : {}),
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    ...(call.signal ? { signal: call.signal } : {}),
    ...(call.trace ? { trace: call.trace } : {}),
    delegation: delegationOf(call.outbound),
  };
}

/**
 * An agent of a composed stack as a member. The call's outbound bounds become the run's `delegation`: the stack runs
 * within what is left of the system run's time, hops and budget (tightening its own limits), and reports its usage and
 * cost back. The abort signal of the pipeline is passed too. On a stack with run control, a waiting run's id is the
 * result's `taskRef`: `resume` continues that run with the input the plexus run was given, `cancel` cancels it.
 */
export function memberFromStack(stack: Stack, options: MemberOptions, id: string): MemberPort {
  if (!stack.agents().includes(options.agent)) {
    throw new TypeError(`agent-layers: agent "${options.agent}" is not configured (known: ${stack.agents().join(', ') || 'none'})`);
  }
  const description = options.description ?? '';
  const { resume, cancel } = runControlOf(stack);
  /** A waiting run names its run id as the handle `resume` and `cancel` take, when the stack has either. */
  const resultOf = (run: RunResult): MemberResult => {
    const result = memberResultOf(run);
    return result.status === 'waiting' && (resume || cancel) ? { ...result, taskRef: run.runId } : result;
  };
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
      const agent = await stack.agent(options.agent);
      return resultOf(await agent.run(inputText(input), runContext(call)));
    },
    ...(resume ? {
      async resume(taskRef: string, input: RunInput | undefined, call: MemberCallContext): Promise<MemberResult> {
        // In process there is no remote work to wait for: a waiting stack run goes on only with an answer.
        if (input === undefined) return refusedResult('invalid', 'a waiting stack run continues only with an answer', taskRef);
        try {
          return resultOf(await resume(taskRef, { input: inputText(input) }, runContext(call)));
        } catch (err) {
          const kind = refusalKind(err);
          if (kind === undefined) throw err;
          return refusedResult(kind, (err as Error).message, taskRef);
        }
      },
    } : {}),
    ...(cancel ? {
      async cancel(taskRef: string, call: MemberCallContext): Promise<void> {
        try {
          await cancel(taskRef, { ...(call.caller ? { by: layersCaller(call.caller, call.credential) } : {}), ...(call.signal ? { signal: call.signal } : {}) });
        } catch (err) {
          // A run that ended or expired has nothing left to cancel.
          if (refusalKind(err) !== 'not_found') throw err;
        }
      },
    } : {}),
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
  capabilities: { resume: RUN_CONTROL, cancel: RUN_CONTROL, checkpoint: false, waits: true },
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
