import { resolve } from 'node:path';
import { lastUserText, outboundBounds } from '@agent-layers/core';
import type { AgentSpec, CallContext, Reservation, Risk, RunInput, RunnableAgent, RunResult, RuntimePort, Stack } from '@agent-layers/core';
import { assemble, loadConfig } from '@agent-plexus/core';
import type { RunContext, System } from '@agent-plexus/core';
import { hostFromStack } from './host.ts';
import { plexusBounds, plexusCaller, runResultOf, NAMESPACE } from './map.ts';

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

/**
 * Run context of the system for one run of the agent: the system run takes the id of the agent run, its lineage, and
 * its bounds (deadline and hops; as budget, what the run reserved for the system).
 */
function contextOf(ctx: CallContext, reserved?: Reservation): Partial<RunContext> {
  return {
    runId: ctx.runId,
    ...(ctx.bounds ? { bounds: plexusBounds(ctx.bounds, reserved) } : {}),
    ...(ctx.lineage ? { lineage: { rootRunId: ctx.lineage.rootRunId, parentRunId: ctx.lineage.parentRunId } } : {}),
    ...(ctx.caller ? { caller: plexusCaller(ctx.caller) } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.trace ? { trace: ctx.trace } : {}),
  };
}

/** Nothing spent: a system that could not run. */
const NOTHING_SPENT = { usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };

/**
 * Runtime whose agent is an agent-plexus system. The system is assembled on the first run of each bound agent, with a
 * host built from the stack that binds it: the stack's authorization, approval, credentials, guards, telemetry and
 * evaluators govern the system's member calls. The system runs within the run's bounds: the run's budget is reserved
 * for it (`outboundBounds`, no local refusal: the system applies the hop limit and the deadline itself) and settled
 * with what the system reports it spent.
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
          // Throws BoundsExceeded when the run has no budget left: the stack ends the run with that stop.
          const reserved = outboundBounds(call, { refuse: false })?.reservation;
          try {
            system ??= assembled(stack, spec);
            const result = await (await system).run(textOf(input), contextOf(call, reserved));
            reserved?.settle({ ...(result.usage ? { usage: result.usage } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) });
            return runResultOf(result, call.runId);
          } catch (err) {
            system = undefined;
            reserved?.settle(NOTHING_SPENT);
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
