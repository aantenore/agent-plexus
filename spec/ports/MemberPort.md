# MemberPort

Layer: `member` (L0 Members) · Version: 0.1.0 · Conformance: planned

## Purpose

Describe one agent and call it. A system holds one MemberPort instance per configured member; the instance hides how
the agent runs (a function, a remote agent, a whole stack).

## Operations

- `describe() → AgentEntry`
  The member as a registry entry. The core calls it once per member and caches the result; it sets the entry `id` to the
  member id.
- `invoke(input: RunInput, ctx: MemberCallContext) → MemberResult`
  Run the member on the input and return its result. Never called directly by a topology: only `memberCall` calls it.
- `resume?(taskRef: String, input: RunInput?, ctx: MemberCallContext) → MemberResult`
  Continue work the member reported as `waiting`. Not called by the core yet.
- `cancel?(taskRef: String, ctx: MemberCallContext) → ()`
  Cancel the member's work for a `taskRef`. Not called by the core yet.
- `native?() → Any`
  The underlying client or function.

## Data shapes

`AgentEntry`, `RunInput`, `MemberResult` and `OutboundBounds` are in [the language](../language.md).
`MemberCallContext` is in the [port index](README.md#common-types).

## Semantics

- `ctx.signal` aborts the call. The core also cuts a call off at the earlier of the time left and
  `limits.system.stepTimeoutMs`, whether or not the member honours the signal; the late result is dropped.
- `ctx.outbound` is what to pass on to a remote agent: `remainingMs` (never a clock time), `hops`, `maxHops`, the budget
  reserved for this call, and the lineage.
- `ctx.credential` is for the member's audience. It is never the caller's credential, and the member must not log it.
- A result whose status is not `completed` has a `reason`. A missing reason is replaced by `{code: "error", layer: "member"}`.
- `usage` and `costUsd` feed the run's budget: what the member does not report is counted as fully spent.
- Only text crosses: `input.parts` are dropped before the call.

## Errors

A member should return problems as results. A thrown error or a result with an unknown status becomes `failed` with
code `error`, layer `member`, and the message as internal `detail`. The core never rejects a `memberCall`.

## Escape hatch

`MemberResult.ext` carries member-specific output under `<adapter>.<name>` keys; `native()` returns the underlying
object.

## Conformance

A `checkMember` suite is planned. It will verify: `describe` returns a valid entry; `invoke` returns a result with a
known status and a reason when it did not complete; an aborted signal ends the call as `stopped` with code `aborted`;
`ext` keys are namespaced.

## Version history

- 0.1.0: initial.
