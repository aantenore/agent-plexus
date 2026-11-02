import { isDeepStrictEqual } from 'node:util';
import { callerIdentity, type AgentEntry, type Caller, type EvalCase, type GateQuestion, type Host, type SystemResult } from '@agent-plexus/core';
import { Checks, settle } from '../check.ts';
import { CANARY_CREDENTIAL } from './member.ts';

export interface HostFixtures {
  /** A member the gate lets `caller` invoke; with it, the suite expects `allow`. */
  member?: AgentEntry;
  /** A member the gate denies `caller`; an approved answer must not turn the deny into an allow. */
  denied?: AgentEntry;
  /** The caller of the run (default: a user without roles). Its credential is replaced by a canary. */
  caller?: Caller;
  /** Another caller, who did not start the run. */
  other?: Caller;
  /** The host lets callers other than the owner resume a run (the default refuses them). */
  othersMayResume?: boolean;
  /** An audience to ask a token for. */
  audience?: string;
  /** A text the gate blocks. */
  block?: { text: string; stage?: 'send' | 'receive' };
  /** A case and a result to score. */
  score?: { case: EvalCase; result: SystemResult };
}

const EFFECTS = ['allow', 'deny', 'ask'];
const ACTIONS = ['allow', 'block', 'redact'];
const sampleMember = (): AgentEntry => ({ id: 'conformance-member', name: 'conformance-member', description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } });

/** Runs the host hook rules H1-H9 against a host. */
export async function checkHost(host: Host, f: HostFixtures = {}, c = new Checks()): Promise<Checks> {
  c.expect('H1', typeof host?.name === 'string' && host.name.length > 0, 'name must be a non-empty string');
  c.expect('H1', host?.tier === 'prototype' || host?.tier === 'production', `tier must be prototype or production, got ${JSON.stringify(host?.tier)}`);
  const gate = host?.gate;
  if (!c.expect('H2', !!gate && ['allow', 'token', 'check'].every((k) => typeof (gate as unknown as Record<string, unknown>)[k] === 'function'), 'gate must have allow, token and check')) return c;
  const owner: Caller = { ...(f.caller ?? { id: 'conformance-owner', kind: 'user', roles: [], scopes: [] }), credential: CANARY_CREDENTIAL };
  const other: Caller = { ...(f.other ?? { id: 'conformance-other', kind: 'user', roles: [], scopes: [] }), credential: `${CANARY_CREDENTIAL}-other` };
  const { credential: _c, ...publicOwner } = owner;
  const { credential: _o, ...publicOther } = other;
  const member = f.member ?? sampleMember();
  const ask = async (rule: string, label: string, q: GateQuestion) => {
    const d = await c.attempt(rule, label, () => gate.allow(q));
    if (d !== undefined) c.expect(rule, !!d && EFFECTS.includes(d.effect), `${label}: effect ${JSON.stringify(d?.effect)} is not allow, deny or ask`);
    return d;
  };

  // H2: invoke decisions.
  const invoke = await ask('H2', 'allow invoke', { action: 'invoke', runId: 'conformance-run', caller: publicOwner, member });
  if (f.member) c.expect('H2', invoke?.effect === 'allow', `allow invoke of ${member.id}: expected allow, got ${invoke?.effect} (${invoke?.reason ?? ''})`);
  await ask('H2', 'allow invoke without caller', { action: 'invoke', runId: 'conformance-run', member });
  await ask('H2', 'allow invoke with an answer', { action: 'invoke', runId: 'conformance-run', caller: publicOwner, member, answer: { approved: true, by: owner.id } });

  // H3: only the owner resumes, unless the host says otherwise.
  const own = await ask('H3', 'resume by the owner', { action: 'resume', runId: 'conformance-run', caller: publicOwner, owner: callerIdentity(owner), member });
  if (f.member) c.expect('H3', own?.effect === 'allow', `resume by the owner: expected allow, got ${own?.effect} (${own?.reason ?? ''})`);
  const stranger = await ask('H3', 'resume by another caller', { action: 'resume', runId: 'conformance-run', caller: publicOther, owner: callerIdentity(owner), member });
  const anonymous = await ask('H3', 'resume by an anonymous caller', { action: 'resume', runId: 'conformance-run', owner: callerIdentity(owner), member });
  const delegated = await ask('H3', 'resume through another delegate', {
    action: 'resume', runId: 'conformance-run', caller: { ...publicOwner, actors: [{ id: 'conformance-agent', kind: 'agent' }] }, owner: callerIdentity(owner), member,
  });
  if (!f.othersMayResume) {
    for (const [label, d] of [['another caller', stranger], ['an anonymous caller', anonymous], ['the owner through another delegate', delegated]] as const) {
      c.expect('H3', d?.effect === 'deny', `resume by ${label}: a run is resumed only by its owner, got ${d?.effect}`);
    }
  }

  // H4: a token is never the caller's own credential.
  for (const audience of [f.audience, 'https://conformance.example'].filter((a): a is string => !!a)) {
    const out = await settle(() => gate.token(owner, audience), c.timeoutMs);
    c.rule('H4');
    if ('error' in out) {
      c.expect('H4', !out.timedOut, `token for ${audience}: timed out`);
      c.expect('H4', !String((out.error as Error)?.message ?? out.error).includes(CANARY_CREDENTIAL), `token for ${audience}: the error must not carry the caller's credential`);
      continue;
    }
    const token = out.value;
    c.expect('H4', token === undefined || typeof token === 'string', `token for ${audience}: must be a string or undefined`);
    c.expect('H4', typeof token !== 'string' || !token.includes(CANARY_CREDENTIAL), `token for ${audience}: must never be the caller's own credential`);
  }

  // H5: check answers allow, block or redact (with text).
  const verdict = async (label: string, text: string, stage: 'send' | 'receive') => {
    const v = await c.attempt('H5', label, () => gate.check({ stage, text, member, runId: 'conformance-run', caller: publicOwner }));
    if (v === undefined) return undefined;
    c.expect('H5', !!v && ACTIONS.includes(v.action), `${label}: action ${JSON.stringify(v?.action)} is not allow, block or redact`);
    if (v?.action === 'redact') c.expect('H5', typeof v.text === 'string', `${label}: a redact needs text`);
    return v;
  };
  await verdict('check send', 'hello', 'send');
  await verdict('check receive', 'hello', 'receive');
  if (f.block) {
    const v = await verdict('check a blocked text', f.block.text, f.block.stage ?? 'send');
    c.expect('H5', v?.action === 'block', `check: the block fixture must be blocked, got ${v?.action}`);
  } else c.skip('H5', 'block: needs the block fixture');

  // H6: telemetry never throws and passes fn's outcome through.
  const t = host.telemetry;
  if (c.expect('H6', !!t && ['span', 'event', 'metric'].every((k) => typeof (t as unknown as Record<string, unknown>)[k] === 'function'), 'telemetry must have span, event and metric')) {
    const value = await c.attempt('H6', 'span', () => t.span('plexus.conformance', { 'plexus.layer': 'member', list: ['a'], none: undefined }, async (span) => {
      span.set({ 'plexus.conformance': 1 });
      span.event('plexus.conformance.event', { ok: true });
      return { v: 1 };
    }));
    c.expect('H6', isDeepStrictEqual(value, { v: 1 }), 'span must resolve to what fn returned');
    const boom = new Error('conformance failure');
    const err = await c.rejects('H6', 'span whose fn rejects', () => t.span('plexus.conformance', { 'plexus.layer': 'member' }, async () => { throw boom; }));
    if (err !== undefined) c.expect('H6', err === boom || (err as Error)?.message === boom.message, 'span must reject with the error fn rejected with');
    for (const [label, call] of [
      ['event', () => t.event('plexus.conformance', { 'plexus.layer': 'member', n: 1, flag: false, list: [], none: undefined })],
      ['metric', () => t.metric('plexus.conformance', 1.5, { 'plexus.layer': 'member' })],
      ['metric of NaN', () => t.metric('plexus.conformance', Number.NaN, {})],
      ['event without attributes', () => t.event('plexus.conformance', {})],
    ] as const) {
      try {
        call();
        c.rule('H6');
      } catch (e) {
        c.fail('H6', `${label} must never throw: ${(e as Error)?.message ?? String(e)}`);
      }
    }
  }

  // H7: scores are in [0, 1].
  if (!host.score) c.skip('H7', 'score is not provided');
  else if (!f.score) c.skip('H7', 'score: needs the score fixture');
  else {
    const scores = await c.attempt('H7', 'score', () => host.score!.score(f.score!.case, f.score!.result));
    if (scores !== undefined && c.expect('H7', Array.isArray(scores), 'score must resolve to a list')) {
      for (const s of scores) {
        c.expect('H7', typeof s.metric === 'string' && s.metric.length > 0, 'a score needs a metric');
        c.expect('H7', typeof s.value === 'number' && s.value >= 0 && s.value <= 1, `score ${s.metric}: value ${s.value} is not in [0, 1]`);
      }
    }
  }

  // H8: state keeps clones.
  if (!host.state) c.skip('H8', 'state is not provided');
  else {
    const state = host.state;
    const key = `conformance-state-${Date.now()}`;
    const value = { list: [1] };
    await c.attempt('H8', 'set', () => state.set(key, value));
    value.list.push(2);
    const got = await c.attempt('H8', 'get', () => state.get(key));
    c.expect('H8', isDeepStrictEqual(got, { list: [1] }), 'state must keep a copy of the value set');
    (got as { list?: number[] } | undefined)?.list?.push(3);
    c.expect('H8', isDeepStrictEqual(await c.attempt('H8', 'get again', () => state.get(key)), { list: [1] }), 'get must return a copy');
    await c.attempt('H8', 'delete', () => state.delete(key));
    c.expect('H8', (await c.attempt('H8', 'get deleted', () => state.get(key))) === undefined, 'a deleted key must read as undefined');
  }

  // H9: an approval is not a permission by itself.
  if (!f.denied) c.skip('H9', 'approval does not override a deny: needs the denied fixture');
  else {
    const plain = await ask('H9', 'allow invoke of a denied member', { action: 'invoke', runId: 'conformance-run', caller: publicOwner, member: f.denied });
    c.expect('H9', plain?.effect === 'deny', `the denied fixture must be denied, got ${plain?.effect}`);
    const approved = await ask('H9', 'allow invoke of a denied member with an approval', { action: 'invoke', runId: 'conformance-run', caller: publicOwner, member: f.denied, answer: { approved: true, by: owner.id } });
    c.expect('H9', approved?.effect !== 'allow', 'an approved answer must not turn a deny into an allow');
  }
  return c;
}
