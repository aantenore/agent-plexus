import { createHash } from 'node:crypto';
import { stableStringify, runGuards } from '@agent-layers/core';
import type { AccessQuestion, ApprovalPort, ComposeOptions, Risk, Stack } from '@agent-layers/core';
import { defineAdapter } from '@agent-plexus/core';
import type { AgentEntry, GateCheck, GateDecision, GateHook, GateQuestion, GateVerdict, Host, ScoreHook, TelemetryHook } from '@agent-plexus/core';
import { evalRunOf, guardStageOf, layersCaller, layersEvalCase, plexusScore, questionCaller } from './map.ts';
import { openStack, type StackOptions } from './stack.ts';

/** Agent name used in guard checks and access questions when a host is built in code without one. */
export const DEFAULT_AGENT = 'agent-plexus';
const DEFAULT_RISK: Risk = 'exec';
const HARNESS = 'harness';

export interface HostOptions extends StackOptions {
  /** Agent name used in guard checks and access questions; the system name when absent. */
  agent?: string;
  /** Risk of calling each member, by member id; `exec` when absent. */
  risk?: Record<string, Risk>;
  /** Members whose calls ask for approval after authorization allowed them. */
  approve?: string[];
}

/** What building a host from an existing stack takes. */
export interface StackHostOptions {
  agent?: string;
  risk?: Record<string, Risk>;
  approve?: readonly string[];
}

const allow = (): GateDecision => ({ effect: 'allow' });
const deny = (reason: string): GateDecision => ({ effect: 'deny', reason });

/** Key of an approval: the caller, the member, the agent and the system run. */
function approvalKey(question: AccessQuestion, runId: string): string {
  const { caller, target } = question;
  const who = caller.kind === 'anonymous' ? 'anonymous' : `${caller.kind}:${caller.id}`;
  return `approval:${createHash('sha256').update(stableStringify({ caller: who, target: target.id, agent: target.agent, runId })).digest('hex')}`;
}

/**
 * Approval for one call. A decision already taken for the key is used first (approved proceeds once, denied denies,
 * pending keeps asking); none, or an expired one, means a new request. Without `lookup` on the port every call asks
 * again.
 */
async function approve(port: ApprovalPort, question: AccessQuestion, agent: string, runId: string): Promise<GateDecision> {
  const key = approvalKey(question, runId);
  let current = port.lookup ? await port.lookup(key, { consume: true }) : undefined;
  if (!current || current.status === 'expired') current = await port.request({ question, agent, runId, key });
  if (current.status === 'approved') return allow();
  if (current.status === 'pending') return { effect: 'ask', reason: `approval pending: ${current.id}` };
  return deny(`approval ${current.status}${current.reason ? `: ${current.reason}` : ''}`);
}

function gateOf(stack: Stack, options: StackHostOptions): GateHook {
  const agent = options.agent ?? DEFAULT_AGENT;
  const production = stack.config.tier === 'production';
  const approvals = new Set(options.approve ?? []);

  const question = (member: AgentEntry, caller: GateQuestion['caller']): AccessQuestion => ({
    caller: questionCaller(caller),
    action: 'call',
    target: {
      kind: 'agent',
      id: member.id,
      layer: HARNESS,
      risk: options.risk?.[member.id] ?? DEFAULT_RISK,
      agent,
      ...(member.attrs ? { attrs: member.attrs } : {}),
    },
  });

  return {
    async allow({ caller, member, runId }) {
      const asked = question(member, caller);
      const { authorization, approval } = stack.ports;
      if (authorization) {
        try {
          const decision = await authorization.evaluate(asked);
          if (decision.allowed !== true) return deny(decision.reason ?? 'denied');
        } catch (err) {
          return deny(`authorization unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (production) {
        return deny('no authorization adapter on a production tier');
      }
      if (!approvals.has(member.id)) return allow();
      if (!approval) return deny('approval required but no approval adapter is configured');
      try {
        return await approve(approval, asked, agent, runId);
      } catch (err) {
        return deny(`approval unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async token(caller, audience) {
      const { credentials } = stack.ports;
      if (!credentials) return undefined;
      return credentials.token(audience, caller ? { caller: layersCaller(caller, caller.credential) } : {});
    },

    async check({ stage, text, member, caller, runId, sessionId }: GateCheck): Promise<GateVerdict> {
      try {
        const ctx = stack.context({ agent, runId, ...(sessionId ? { sessionId } : {}), ...(caller ? { caller: layersCaller(caller) } : {}) });
        const outcome = await runGuards(stack.ports.guardrails, guardStageOf(stage), text, ctx, stack.telemetry, member.id);
        if (outcome.action === 'block') return { action: 'block', reason: `${outcome.guard ?? 'guard'}${outcome.reason ? `: ${outcome.reason}` : ''}` };
        if (outcome.action === 'redact') return { action: 'redact', text: outcome.text };
        return { action: 'allow' };
      } catch (err) {
        return { action: 'block', reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function telemetryOf(stack: Stack): TelemetryHook {
  const layered = <T extends object>(attrs: T) => ({ ...attrs, 'agent.layer': HARNESS }) as T & { 'agent.layer': typeof HARNESS };
  return {
    span: (name, attrs, fn) => stack.telemetry.span(name, layered(attrs), (span) => fn({
      set: (a) => span.setAttributes(a),
      event: (n, a) => span.addEvent(n, a),
    })),
    event: (name, attrs) => stack.telemetry.event(name, layered(attrs)),
    metric: (name, value, attrs) => stack.telemetry.metric(name, value, layered(attrs)),
  };
}

function scoreOf(stack: Stack): ScoreHook | undefined {
  const evaluators = stack.ports.eval;
  if (!evaluators.length) return undefined;
  return {
    async score(evalCase, result) {
      const mapped = layersEvalCase(evalCase);
      const run = evalRunOf(result);
      const scores = await Promise.all(evaluators.map((e) => e.score(mapped, run)));
      return scores.flat().map(plexusScore);
    },
  };
}

/**
 * A host over a composed stack: `gate` from its authorization, approval, credential and guard ports, `telemetry` from
 * its telemetry fan-out, `score` from its evaluators. No `state`: StatePort is an append-only event log per session,
 * not a key/value store. The tier is the stack's. The stack is not closed with the host.
 */
export function hostFromStack(stack: Stack, options: StackHostOptions = {}): Host {
  const score = scoreOf(stack);
  return {
    name: 'agent-layers',
    tier: stack.config.tier,
    gate: gateOf(stack, options),
    telemetry: telemetryOf(stack),
    ...(score ? { score } : {}),
  };
}

/** Composes the configured stack once and builds a host over it; closing the host closes the stack. */
export async function createHost(options: HostOptions, cwd: string, composeOptions?: ComposeOptions): Promise<Host & { close(): Promise<void> }> {
  const stack = await openStack(options, cwd, composeOptions);
  return { ...hostFromStack(stack, options), close: () => stack.close() };
}

export const hostAdapter = defineAdapter<'Host', HostOptions>({
  fills: 'Host',
  name: 'agent-layers',
  maps: { technology: 'agent-layers stack' },
  tiers: ['prototype', 'production'],
  description: 'Builds the host hooks from a composed agent-layers stack: authorization, approval, credentials, guards, telemetry and evaluators.',
  optionsSchema: {
    type: 'object',
    properties: {
      config: { type: 'string', minLength: 1 },
      profile: { type: 'string', minLength: 1 },
      agent: { type: 'string', minLength: 1 },
      risk: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
      approve: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    required: ['config'],
    additionalProperties: false,
  },
  create: (options, ctx) => createHost({ ...options, agent: options.agent ?? ctx.system }, ctx.cwd),
});
