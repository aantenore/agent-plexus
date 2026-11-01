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
  Continue remote work: with `input` undefined, wait for the work behind `taskRef` and return its result; with an
  input, send what a waiting member asked for. The core calls it with `input` undefined, and only to continue a call
  whose `taskRef` an earlier attempt checkpointed (see "Two-phase call").
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

### Two-phase call

A member that starts remote work (a task on another server) can make the call resumable:

1. Right after the remote side accepts the work, the member calls `ctx.checkpoint(taskRef)`. The core keeps the
   handle in the journal of the run, under `call:<node path>:<index>:task`. A handle that is not a non-empty string of
   at most 1024 characters is ignored (event `plexus.checkpoint.ignored`).
2. Before calling, the core looks for a handle kept for this step. With one, and a member that has `resume`, it calls
   `resume(taskRef, undefined, ctx)` instead of `invoke` and records the event `plexus.member.resumed` on the hop span
   (no content). Without a handle, or for a member with no `resume`, it calls `invoke`.
3. Only the step as a whole is journaled when the member returns. A finished step replays its stored result and neither
   `invoke` nor `resume` runs.

A crash between sending the request and the checkpoint leaves no handle, so the request can be sent twice. A member
should tolerate a repeated request (an idempotency key, or work that is safe to repeat). A member that does not
checkpoint is always invoked again after a crash.

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

- 0.1.0: initial; `ctx.checkpoint` and a `resume` that waits for remote work added before release.
