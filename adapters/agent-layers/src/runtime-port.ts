import { resolve } from 'node:path';
import { lastUserText } from '@agent-layers/core';
import type { AgentSpec, CallContext, Risk, RunInput, RunnableAgent, RunResult, RuntimePort, Stack } from '@agent-layers/core';
import { assemble, loadConfig } from '@agent-plexus/core';
import type { RunContext, System } from '@agent-plexus/core';
import { hostFromStack } from './host.ts';
import { plexusCaller, runResultOf, NAMESPACE } from './map.ts';

export interface RuntimeOptions {
  /** Path of the agent-plexus system config, relative to the directory of the agent-layers config. */
  system: string;
  profile?: string;
  /** Risk of calling each member, by member id; same meaning as in the host adapter. */
  risk?: Record<string, Risk>;
  /** Members whose calls ask for approval; same meaning as in the host adapter. */
  approve?: string[];
}

const textOf = (input: RunInput): string => (typeof input === 'string' ? input : lastUserText(input.messages));

/** Run context of the system for one run of the agent: the system run takes the id of the agent run. */
function contextOf(ctx: CallContext): Partial<RunContext> {
  return {
    runId: ctx.runId,
    ...(ctx.caller ? { caller: plexusCaller(ctx.caller) } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.trace ? { trace: ctx.trace } : {}),
  };
}

/**
 * Runtime whose agent is an agent-plexus system. The system is assembled on the first run of each bound agent, with a
 * host built from the stack that binds it: the stack's authorization, approval, credentials, guards, telemetry and
 * evaluators govern the system's member calls.
 */
export function createRuntime(options: RuntimeOptions, cwd: string, name = NAMESPACE): RuntimePort {
  const systems: Promise<System>[] = [];

  const assembled = (stack: Stack, spec: AgentSpec): Promise<System> => {
    const system = loadConfig(resolve(cwd, options.system), options.profile ? { profile: options.profile } : {})
      .then((config) => assemble(config, { host: hostFromStack(stack, { agent: spec.name, ...(options.risk ? { risk: options.risk } : {}), ...(options.approve ? { approve: options.approve } : {}) }) }));
    systems.push(system);
    return system;
  };

  return {
    name,
    bind(stack, spec): RunnableAgent {
      let system: Promise<System> | undefined;
      return {
        name: spec.name,
        async run(input, ctx): Promise<RunResult> {
          const call = stack.context({ ...ctx, agent: spec.name });
          try {
            system ??= assembled(stack, spec);
            const result = await (await system).run(textOf(input), contextOf(call));
            return runResultOf(result, call.runId);
          } catch (err) {
            system = undefined;
            return { runId: call.runId, status: 'failed', output: '', reason: { code: 'error', layer: 'harness', by: name, detail: err instanceof Error ? err.name : 'Error' } };
          }
        },
      };
    },
    async close() {
      await Promise.allSettled(systems.map(async (s) => (await s).close()));
    },
  };
}
