import { createHash } from 'node:crypto';
import { stableStringify, runGuards } from '@agent-layers/core';
import type { AccessQuestion, ApprovalPort, ComposeOptions, JsonValue, Risk, Stack } from '@agent-layers/core';
import { CANCEL_OWNER_ONLY, defineAdapter, expectedScores, RESUME_OWNER_ONLY, sameIdentity } from '@agent-plexus/core';
import type {
  AgentEntry, CancelQuestion, GateAnswer, GateCheck, GateDecision, GateHook, GateQuestion, GateVerdict, Host, ResumeQuestion, ScoreHook, StateHook,
  TelemetryHook,
} from '@agent-plexus/core';
import { evalRunOf, guardStageOf, layersCaller, layersEvalCase, NAMESPACE, plexusScore, questionCaller } from './map.ts';
import { openStack, type StackOptions } from './stack.ts';

/** Agent name used in guard checks and access questions when a host is built in code without one. */
export const DEFAULT_AGENT = 'agent-plexus';
const DEFAULT_RISK: Risk = 'exec';
const HARNESS = 'harness';
/** Action of the access question for continuing a waiting run; `call` is the one for calling a member. */
export const RESUME_ACTION = 'resume';
/** Action of the access question for cancelling a run. */
export const CANCEL_ACTION = 'cancel';
/** `ext` key of a resume or cancel question that carries the identity of the caller that started the run. */
export const OWNER_KEY = `${NAMESPACE}.owner`;
/** Namespace of the StorePort keys the `state` hook writes: `plexus.<key>`. */
export const STATE_NAMESPACE = 'plexus';

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

/**
 * Approval for a call a person answered through `System.resume`. The pending approval of the call (found with `lookup`)
 * is decided with the answer, `by` the resuming caller; a decision already taken elsewhere stands. A denial denies; an
 * approval is then consumed like any other. Without `lookup` the approval id is not known: the call goes through
 * `approve`, and a denial still denies.
 */
async function answered(port: ApprovalPort, question: AccessQuestion, agent: string, runId: string, answer: GateAnswer): Promise<GateDecision> {
  const key = approvalKey(question, runId);
  const pending = port.lookup ? await port.lookup(key) : undefined;
  if (pending?.status === 'pending') {
    const decision = { approved: answer.approved, ...(answer.by !== undefined ? { by: answer.by } : {}), ...(answer.reason ? { reason: answer.reason } : {}) };
    try {
      await port.decide(pending.id, decision);
    } catch (err) {
      // Decided by someone else in the meantime: that decision stands; anything else is an error.
      if ((await port.get(pending.id))?.status === 'pending') throw err;
    }
  }
  if (!answer.approved) return deny(`approval denied${answer.by !== undefined ? ` by ${answer.by}` : ''}`);
  return approve(port, question, agent, runId);
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

  /**
   * The access question of a resume or a cancel: the call's question with that action, about the member the run waits
   * on (or the run itself when it waits on none), and the owner's identity under `ext`.
   */
  const controlQuestion = ({ caller, member, owner, runId }: ResumeQuestion | CancelQuestion, action: string): AccessQuestion => ({
    ...(member ? question(member, caller) : {
      caller: questionCaller(caller),
      target: { kind: 'run', id: runId, layer: HARNESS, risk: DEFAULT_RISK, agent },
    }),
    action,
    ...(owner ? { ext: { [OWNER_KEY]: { id: owner.id, kind: owner.kind } } } : {}),
  });

  /** Undefined when authorization allows the question; otherwise the deny. */
  const authorize = async (asked: AccessQuestion): Promise<GateDecision | undefined> => {
    const { authorization } = stack.ports;
    if (!authorization) return production ? deny('no authorization adapter on a production tier') : undefined;
    try {
      const decision = await authorization.evaluate(asked);
      return decision.allowed === true ? undefined : deny(decision.reason ?? 'denied');
    } catch (err) {
      return deny(`authorization unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    async allow(q) {
      // A run is continued or cancelled only by its owner, whatever the policy; the policy may still refuse the owner.
      if (q.action === 'resume') return sameIdentity(q.caller, q.owner) ? (await authorize(controlQuestion(q, RESUME_ACTION))) ?? allow() : deny(RESUME_OWNER_ONLY);
      if (q.action === 'cancel') return sameIdentity(q.caller, q.owner) ? (await authorize(controlQuestion(q, CANCEL_ACTION))) ?? allow() : deny(CANCEL_OWNER_ONLY);
      const { caller, member, runId } = q;
      const asked = question(member, caller);
      const denied = await authorize(asked);
      if (denied) return denied;
      const { approval } = stack.ports;
      if (!approvals.has(member.id)) return allow();
      if (!approval) return deny('approval required but no approval adapter is configured');
      try {
        return await (q.answer ? answered(approval, asked, agent, runId, q.answer) : approve(approval, asked, agent, runId));
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
    async score(evalCase, result, ctx) {
      const mapped = layersEvalCase(evalCase);
      const run = evalRunOf(result);
      const scores = await Promise.all(evaluators.map((e) => e.score(mapped, run)));
      // The evaluators see the system's output only: expectations on members are checked here, on the stored texts.
      const members = evalCase.expected?.members;
      const memberScores = members ? await expectedScores({ id: evalCase.id, input: evalCase.input, expected: { members } }, result, ctx?.read) : [];
      return [...scores.flat().map(plexusScore), ...memberScores];
    },
  };
}

/**
 * `state` over the stack's StorePort, keys under `plexus.`; undefined without a store. A value must be JSON. A write the
 * store refuses is an error.
 */
function stateOf(stack: Stack): StateHook | undefined {
  const { store } = stack.ports;
  if (!store) return undefined;
  const keyOf = (key: string) => `${STATE_NAMESPACE}.${key}`;
  return {
    async get(key) {
      return (await store.get(keyOf(key)))?.value;
    },
    async set(key, value) {
      const written = await store.set(keyOf(key), value as JsonValue);
      if (!written.ok) throw new Error(`state: the store refused the write of ${keyOf(key)}`);
    },
    async delete(key) {
      await store.delete(keyOf(key));
    },
  };
}

/**
 * A host over a composed stack: `gate` from its authorization, approval, credential and guard ports, `telemetry` from
 * its telemetry fan-out, `score` from its evaluators, `state` from its StorePort when it has one. The tier is the
 * stack's. The stack is not closed with the host.
 */
export function hostFromStack(stack: Stack, options: StackHostOptions = {}): Host {
  const score = scoreOf(stack);
  const state = stateOf(stack);
  return {
    name: 'agent-layers',
    tier: stack.config.tier,
    gate: gateOf(stack, options),
    telemetry: telemetryOf(stack),
    ...(score ? { score } : {}),
    ...(state ? { state } : {}),
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
  description: 'Builds the host hooks from a composed agent-layers stack: authorization, approval, credentials, guards, telemetry, evaluators and store.',
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
