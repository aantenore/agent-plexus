/**
 * Host hooks: control and insight that agent-plexus receives instead of implementing. A host is passed to
 * `assemble(config, host)`. Each hook has a prototype default (prototype-host.ts) that the readiness gate refuses on a
 * production-tier profile.
 */
import type { AgentEntry, Caller, EvalCase, Score, SystemResult } from './shapes.ts';

export interface GateQuestion {
  /** The system run the call belongs to. */
  runId: string;
  sessionId?: string;
  caller?: Caller;
  action: 'invoke';
  member: AgentEntry;
}

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

/** Authorization, credentials and content checks for every member call. Errors are a deny. */
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
