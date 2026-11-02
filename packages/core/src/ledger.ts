import type { Bounds, OutboundBounds, RunContext, Usage } from './shapes.ts';
import { limitNumber, type SystemLimits } from './system-limits.ts';

/** Latest instant a Date can hold; stands for "no deadline". */
const MAX_DATE_MS = 8.64e15;

/** Time of a bounds deadline in epoch milliseconds; an unreadable deadline counts as already passed. */
export function deadlineMs(bounds: Bounds): number {
  const ms = Date.parse(bounds.deadlineAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Who set the run deadline, as the `by` of a timeout reason. */
export type DeadlineBy = 'limits.system.timeoutMs' | 'host.bounds';

const ownDeadline = (limits: SystemLimits, now: number): number => Math.min(now + limitNumber(limits.timeoutMs), MAX_DATE_MS);

/** Whether `openBounds` took the deadline from the host's bounds (strictly earlier) or from the system's timeout. */
export function deadlineBy(ctx: RunContext, limits: SystemLimits, now: number): DeadlineBy {
  return ctx.bounds && deadlineMs(ctx.bounds) < ownDeadline(limits, now) ? 'host.bounds' : 'limits.system.timeoutMs';
}

/**
 * The bounds a run works within: what the host passed in, tightened by the system's limits. The deadline is the
 * earlier of the host's and `now + timeoutMs`; hops and the budget are the host's, and without `maxHops` the run may
 * add `maxDepth` hops.
 */
export function openBounds(ctx: RunContext, limits: SystemLimits, now: number): Bounds {
  const host = ctx.bounds;
  const own = ownDeadline(limits, now);
  const hops = host?.hops ?? 0;
  const depth = limitNumber(limits.maxDepth);
  return {
    deadlineAt: new Date(Math.min(own, host ? deadlineMs(host) : own)).toISOString(),
    hops,
    maxHops: host?.maxHops ?? (Number.isFinite(depth) ? hops + depth : Number.MAX_SAFE_INTEGER),
    ...(host?.tokens !== undefined ? { tokens: host.tokens } : {}),
    ...(host?.costUsd !== undefined ? { costUsd: host.costUsd } : {}),
  };
}

/** Budget set aside for one member call; only the ledger that issued it can settle it. */
export interface Reservation {
  readonly tokens?: number;
  readonly costUsd?: number;
}

/** What a member reported it spent. */
export interface Spent {
  usage?: Usage;
  costUsd?: number;
}

/** What a run has spent so far, over all its invocations: kept in the journal as `run:spent`. */
export interface SpentTotals {
  tokens: number;
  costUsd: number;
}

const amount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A kept `run:spent` value; anything else counts as nothing spent. */
export function spentTotals(value: unknown): SpentTotals {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<SpentTotals>;
  return { tokens: amount(v.tokens) ? v.tokens : 0, costUsd: amount(v.costUsd) ? v.costUsd : 0 };
}

/**
 * Budget of one run. Calls reserve a share of what is not spent, capped by what no other call has reserved, then
 * settle with what the member reported; a dimension the member did not report counts as fully spent, unless the call
 * goes on later (it ended waiting): then it counts as nothing, and the call's continuation settles the rest. Updates are
 * synchronous, so parallel calls never over-reserve. `spent` is what earlier invocations of the run spent: the budget
 * is the run's, not the invocation's.
 */
export class Ledger {
  readonly bounds: Bounds;
  /** Who chose `bounds.deadlineAt`. */
  readonly deadlineBy: DeadlineBy;
  readonly #now: () => number;
  readonly #open = new Set<Reservation>();
  #tokens: number | undefined;
  #costUsd: number | undefined;
  readonly #spent: SpentTotals;
  readonly #inherited: boolean;

  constructor(bounds: Bounds, now: () => number = Date.now, by: DeadlineBy = 'limits.system.timeoutMs', spent?: SpentTotals) {
    this.bounds = bounds;
    this.deadlineBy = by;
    this.#now = now;
    this.#spent = spentTotals(spent);
    this.#inherited = this.#spent.tokens > 0 || this.#spent.costUsd > 0;
    this.#tokens = bounds.tokens === undefined ? undefined : Math.max(0, bounds.tokens - this.#spent.tokens);
    this.#costUsd = bounds.costUsd === undefined ? undefined : Math.max(0, bounds.costUsd - this.#spent.costUsd);
  }

  /** Whether earlier invocations of the run spent anything: their steps may replay, which needs no budget. */
  get inherited(): boolean {
    return this.#inherited;
  }

  /** What the run has spent, earlier invocations included; a dimension nobody reported or reserved adds nothing. */
  spent(): SpentTotals {
    return { ...this.#spent };
  }

  /** What is neither spent nor reserved; a dimension the host did not bound is absent. */
  remaining(): { tokens?: number; costUsd?: number } {
    let tokens = this.#tokens;
    let costUsd = this.#costUsd;
    for (const r of this.#open) {
      if (tokens !== undefined && r.tokens !== undefined) tokens -= r.tokens;
      if (costUsd !== undefined && r.costUsd !== undefined) costUsd -= r.costUsd;
    }
    return {
      ...(tokens !== undefined ? { tokens: Math.max(0, tokens) } : {}),
      ...(costUsd !== undefined ? { costUsd: Math.max(0, costUsd) } : {}),
    };
  }

  /**
   * Reserves `share` (0..1, default all) of what is not spent, capped by what the open reservations leave: concurrent
   * calls with shares that sum to at most 1 each get their share, whatever order they reserve in. Undefined when a
   * bounded dimension has nothing left to reserve.
   */
  reserve(share = 1): Reservation | undefined {
    const fraction = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
    const left = this.remaining();
    const tokens = left.tokens === undefined ? undefined : Math.min(left.tokens, Math.floor(this.#tokens! * fraction));
    const costUsd = left.costUsd === undefined ? undefined : Math.min(left.costUsd, this.#costUsd! * fraction);
    if ((tokens !== undefined && tokens <= 0) || (costUsd !== undefined && costUsd <= 0)) return undefined;
    const reservation: Reservation = { ...(tokens !== undefined ? { tokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
    this.#open.add(reservation);
    return reservation;
  }

  /**
   * Debits what was reported and releases the rest. A dimension nothing was reported for debits the whole reservation,
   * or nothing when `partial`: the call goes on later (it ended waiting) and its continuation reports what it spends.
   */
  settle(reservation: Reservation, spent?: Spent, partial = false): void {
    if (!this.#open.delete(reservation)) return;
    const usage = spent?.usage;
    const unreported = (reserved: number | undefined): number | undefined => (partial ? undefined : reserved);
    const tokens = usage && amount(usage.inputTokens) && amount(usage.outputTokens) ? usage.inputTokens + usage.outputTokens : unreported(reservation.tokens);
    const costUsd = amount(spent?.costUsd) ? spent.costUsd : unreported(reservation.costUsd);
    if (tokens !== undefined) this.#spent.tokens += tokens;
    if (costUsd !== undefined) this.#spent.costUsd += costUsd;
    if (this.#tokens !== undefined && tokens !== undefined) this.#tokens = Math.max(0, this.#tokens - tokens);
    if (this.#costUsd !== undefined && costUsd !== undefined) this.#costUsd = Math.max(0, this.#costUsd - costUsd);
  }

  /** Gives a reservation back unspent: the call never reached the member. */
  release(reservation: Reservation): void {
    this.#open.delete(reservation);
  }

  /**
   * What crosses to the next agent: time left minus `marginMs`, one more hop, the reserved budget. The call is cut at
   * `stepMs` too, so the time told never exceeds the shorter of the run deadline and the step limit.
   */
  outbound(runId: string, rootRunId: string, reservation: Reservation, marginMs: number, stepMs = Infinity): OutboundBounds {
    return {
      remainingMs: Math.max(0, Math.min(deadlineMs(this.bounds) - this.#now(), stepMs) - marginMs),
      hops: this.bounds.hops + 1,
      maxHops: this.bounds.maxHops,
      ...(reservation.tokens !== undefined ? { tokens: reservation.tokens } : {}),
      ...(reservation.costUsd !== undefined ? { costUsd: reservation.costUsd } : {}),
      rootRunId,
      parentRunId: runId,
    };
  }
}
