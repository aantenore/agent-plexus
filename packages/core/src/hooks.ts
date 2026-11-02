/**
 * Host hooks: control and insight that agent-plexus receives instead of implementing. A host is passed to
 * `assemble(config, host)`. Each hook has a prototype default (prototype-host.ts) that the readiness gate refuses on a
 * production-tier profile.
 */
import type { AgentEntry, Caller, CallerIdentity, EvalCase, Score, SystemResult } from './shapes.ts';

/** A person's answer, through `System.resume`, to an earlier `ask`; `by` is the id of the caller that resumed. */
export interface GateAnswer {
  approved: boolean;
  reason?: string;
  by?: string;
}

interface GateQuestionBase {
  /** The system run the call belongs to. */
  runId: string;
  sessionId?: string;
  /** Who asks: the caller of the run, or the caller that resumes it. Never with its credential. */
  caller?: Caller;
}

/** May `caller` call `member`. */
export interface InvokeQuestion extends GateQuestionBase {
  action: 'invoke';
  member: AgentEntry;
  /**
   * The answer, through `System.resume`, to an earlier `ask` for this call. The host decides again: an approval is not
   * a permission by itself.
   */
  answer?: GateAnswer;
}

/**
 * May `caller` continue a run that `owner` started: `System.resume`, or `run` with the id of a run the journal knows
 * when the caller is not its owner. Asked before any reply is delivered.
 */
export interface ResumeQuestion extends GateQuestionBase {
  action: 'resume';
  /** The caller that started the run, identity only; absent when the run started without a caller. */
  owner?: CallerIdentity;
  /** The member the run waits on; absent when the run waits on nothing or the member cannot describe itself. */
  member?: AgentEntry;
  /** The approval this resume gives to a gate's `ask`, with `by` set to the resuming caller's id. */
  answer?: GateAnswer;
}

export type GateQuestion = InvokeQuestion | ResumeQuestion;

export interface GateDecision {
  effect: 'allow' | 'deny' | 'ask';
  /** Internal, never shown to a caller. */
  reason?: string;
}

export interface GateCheck {
  stage: 'send' | 'receive';
  text: string;
  member: AgentEntry;
  /** The system run the call belongs to. */
  runId: string;
  sessionId?: string;
  caller?: Caller;
}

export interface GateVerdict {
  action: 'allow' | 'block' | 'redact';
  /** Required for `redact`. */
  text?: string;
  reason?: string;
}

/** Authorization, credentials and content checks for every member call, and authorization of a resume. Errors are a deny. */
export interface GateHook {
  allow(question: GateQuestion): Promise<GateDecision>;
  /** A credential for the member's audience, on behalf of the caller; undefined when none is needed. */
  token(caller: Caller | undefined, audience: string): Promise<string | undefined>;
  check(check: GateCheck): Promise<GateVerdict>;
}

export type Attributes = Record<string, string | number | boolean | string[] | undefined>;

export interface SpanHandle {
  set(attrs: Attributes): void;
  event(name: string, attrs?: Attributes): void;
}

/** Spans, events and metrics. The core names everything `plexus.*` and always sets `plexus.layer`. */
export interface TelemetryHook {
  span<T>(name: string, attrs: Attributes, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
  event(name: string, attrs: Attributes): void;
  metric(name: string, value: number, attrs: Attributes): void;
}

export interface ScoreHook {
  score(evalCase: EvalCase, result: SystemResult): Promise<Score[]>;
}

export interface StateHook {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Host {
  name: string;
  /** `prototype` hosts are refused by the readiness gate of a production-tier profile. */
  tier: 'prototype' | 'production';
  gate: GateHook;
  telemetry: TelemetryHook;
  score?: ScoreHook;
  state?: StateHook;
}
