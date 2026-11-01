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

const amount = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Budget of one run. Calls reserve a share of what is left, then settle with what the member reported; a dimension
 * the member did not report counts as fully spent. Updates are synchronous, so parallel calls never over-reserve.
 */
export class Ledger {
  readonly bounds: Bounds;
  /** Who chose `bounds.deadlineAt`. */
  readonly deadlineBy: DeadlineBy;
  readonly #now: () => number;
  readonly #open = new Set<Reservation>();
  #tokens: number | undefined;
  #costUsd: number | undefined;

  constructor(bounds: Bounds, now: () => number = Date.now, by: DeadlineBy = 'limits.system.timeoutMs') {
    this.bounds = bounds;
    this.deadlineBy = by;
    this.#now = now;
    this.#tokens = bounds.tokens;
    this.#costUsd = bounds.costUsd;
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
   * Reserves `share` (0..1, default all) of what is left after the open reservations. Undefined when a bounded
   * dimension has nothing left to reserve.
   */
  reserve(share = 1): Reservation | undefined {
    const fraction = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
    const left = this.remaining();
    const tokens = left.tokens === undefined ? undefined : Math.floor(left.tokens * fraction);
    const costUsd = left.costUsd === undefined ? undefined : left.costUsd * fraction;
    if ((tokens !== undefined && tokens <= 0) || (costUsd !== undefined && costUsd <= 0)) return undefined;
    const reservation: Reservation = { ...(tokens !== undefined ? { tokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
    this.#open.add(reservation);
    return reservation;
  }

  /** Debits what was reported (or the whole reservation when nothing was) and releases the rest. */
  settle(reservation: Reservation, spent?: Spent): void {
    if (!this.#open.delete(reservation)) return;
    const usage = spent?.usage;
    const tokens = usage && amount(usage.inputTokens) && amount(usage.outputTokens) ? usage.inputTokens + usage.outputTokens : reservation.tokens;
    const costUsd = amount(spent?.costUsd) ? spent.costUsd : reservation.costUsd;
    if (this.#tokens !== undefined && tokens !== undefined) this.#tokens = Math.max(0, this.#tokens - tokens);
    if (this.#costUsd !== undefined && costUsd !== undefined) this.#costUsd = Math.max(0, this.#costUsd - costUsd);
  }

  /** Gives a reservation back unspent: the call never reached the member. */
  release(reservation: Reservation): void {
    this.#open.delete(reservation);
  }

  /** What crosses to the next agent: time left minus `marginMs`, one more hop, the reserved budget. */
  outbound(runId: string, rootRunId: string, reservation: Reservation, marginMs: number): OutboundBounds {
    return {
      remainingMs: Math.max(0, deadlineMs(this.bounds) - this.#now() - marginMs),
      hops: this.bounds.hops + 1,
      maxHops: this.bounds.maxHops,
      ...(reservation.tokens !== undefined ? { tokens: reservation.tokens } : {}),
      ...(reservation.costUsd !== undefined ? { costUsd: reservation.costUsd } : {}),
      rootRunId,
      parentRunId: runId,
    };
  }
}
