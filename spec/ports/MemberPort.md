# MemberPort

Layer: `member` (L0 Members) · Version: 0.1.0 · Conformance: [`checkMember`](../../packages/conformance) in `@agent-plexus/conformance`

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
  input, send what a waiting member asked for. The core calls it with `input` undefined to continue a call whose
  `taskRef` an earlier attempt checkpointed (see "Two-phase call"), and with an input when `System.resume` answers a
  member that waits (see "Waiting for input").
- `cancel?(taskRef: String, ctx: MemberCallContext) → ()`
  Cancel the member's work for a `taskRef`. The core calls it, best effort, for a call whose task it knows (a handle
  the member checkpointed, continued, or returned with `waiting`): right after the core cut the call off, and when the
  topology abandons a call that ended `waiting` (`scope.abandon`, a `parallel` with `join: "first"`). The core cuts a
  call off when its signal aborts before the member answered: the run's or the call's abort, or the core's own step or
  deadline timeout. `ctx` is the call's context with a fresh `signal` that fires after
  `limits.system.cancelTimeoutMs`; the core stops waiting then. A cancel that throws or takes longer is reported as the
  telemetry event `plexus.member.cancel_failed` (with `plexus.member` and `plexus.hop`) and changes no result. Once it
  cancelled a task, the core forgets the step's handle (it keeps `null` under `call:<node path>:<n>:task`): a later
  invocation of the run neither resumes nor cancels it again, and a reply to that wait stops with `rejected`. What the
  member returned itself (completed, failed, stopped, or a journaled `waiting` it was not abandoned in) and a replayed
  call are never cancelled.
  The rule for a member: the core cancels a checkpointed task whenever it cuts a call off, so a member leaves that task
  to the core. A member cancels on its own only for its own deadline or errors, and for a task whose handle had not
  reached the core (not checkpointed, not resumed) when the call was cut off.
- `native?() → Any`
  The underlying client or function.

## Data shapes

`AgentEntry`, `RunInput`, `MemberResult` and `OutboundBounds` are in [the language](../language.md).
`MemberCallContext` is in the [port index](README.md#common-types).

### Capabilities

A MemberPort adapter descriptor may declare `capabilities?: {resume?, cancel?, checkpoint?, waits?}`, booleans saying
what its members do beyond `describe` and `invoke`: `resume` and `cancel` implement those operations, `checkpoint`
calls `ctx.checkpoint`, `waits` can end a call `waiting` for input. Only MemberPort adapters declare it; an unknown key
is refused when the descriptor is checked. The readiness gate warns, on any tier, about a member whose adapter declares
`waits` without `resume` (a run waiting on it cannot continue), and about a member that `checkpoint`s without `cancel`
in a branch of a `parallel` with `join: "first"` (its abandoned remote work keeps running).

## Semantics

- `ctx.signal` aborts the call. The core also cuts a call off at the earlier of the time left and
  `limits.system.stepTimeoutMs`, whether or not the member honours the signal; the late result is dropped. Its own
  timer aborts `ctx.signal` with a `DOMException` named `TimeoutError` as the reason, so a member can tell a timeout
  from an abort.
- `ctx.outbound` is what to pass on to a remote agent: `remainingMs` (never a clock time), `hops`, `maxHops`, the budget
  reserved for this call, and the lineage.
- `ctx.credential` is for the member's audience. It is never the caller's credential, and the member must not log it.
- A result whose status is not `completed` has a `reason`. A missing reason is replaced by `{code: "error", layer: "member"}`.
  The member's own name for where it stopped (a layer of its own stack) goes in `reason.memberLayer`; a member MUST NOT
  set `reason.layer` to anything but `member` (see [the language](../language.md#stop-reasons)). The core keeps a
  member's reason under layer `member`: a plexus layer or `host` it names moves to `memberLayer` (unless one is set),
  so a member cannot pass a stop off as the host's or another layer's.
- `usage` and `costUsd` feed the run's budget: what the member does not report is counted as fully spent, except for
  a call that ends `waiting`, which spends what it reported; its continuation settles the rest. Values that are not
  finite non-negative numbers are dropped, with the event `plexus.member.figure_dropped` on the hop span.
- Only text crosses: `input.parts` are dropped before the call.

### Two-phase call

A member that starts remote work (a task on another server) can make the call resumable:

1. Right after the remote side accepts the work, the member calls `ctx.checkpoint(taskRef)`. The core keeps the
   handle in the journal of the run, under `call:<node path>:<n>:task`. A handle that is not a non-empty string of
   at most 1024 characters is ignored (event `plexus.checkpoint.ignored`).
2. Before calling, the core looks for a handle kept for this step. With one, and a member that has `resume`, it calls
   `resume(taskRef, undefined, ctx)` instead of `invoke` and records the event `plexus.member.resumed` on the hop span
   (no content). Without a handle, or for a member with no `resume`, it calls `invoke`.
3. Only the step as a whole is journaled when the member returns, whatever the status it returned. A call that throws,
   times out or is aborted journals nothing, so a run begun again calls the member again (through `resume` when a
   handle was kept). A finished step replays its stored result and neither `invoke` nor `resume` runs.

A crash between sending the request and the checkpoint leaves no handle, so the request can be sent twice. A member
should tolerate a repeated request (an idempotency key, or work that is safe to repeat). A member that does not
checkpoint is always invoked again after a crash.

### Waiting for input

A member that needs more from a person returns `waiting` with code `needs_input` (or `needs_auth`) and its handle,
checkpointed or in `taskRef`. The run ends `waiting`. `System.resume(runId, {input})` runs it again: completed steps
replay, and the waiting call checks the input with the gate (`check`, stage `send`) and calls
`resume(taskRef, input, ctx)` as the step `call:<node path>:<n>#<attempt>`. A member without `resume`, or without a kept
handle, stops with code `rejected`, layer `member`. The hop record carries `attempt: n`.

## Errors

A member should return problems as results. A thrown error or a result with an unknown status becomes `failed` with
code `error`, layer `member`, and the message as internal `detail`. The core never rejects a `memberCall`.

## Escape hatch

`MemberResult.ext` carries member-specific output under `<adapter>.<name>` keys; `native()` returns the underlying
object.

## Conformance

`checkMember` in [`@agent-plexus/conformance`](../../packages/conformance) checks this port: rules M1-M10. Among them: `describe` returns a valid entry; `invoke` returns a result with a known status and a reason when it did not complete; an aborted signal ends the call as `stopped` with code `aborted`; the descriptor declares `capabilities`; `ext` keys are namespaced; a reason's `layer`, when set, is `member`. The package README lists all the rules.

## Version history

- 0.1.0: initial; `ctx.checkpoint`, a `resume` that waits for remote work, `cancel` called by the core and descriptor
  `capabilities` added before release.
- 0.1.0, as the core implements it from package 0.2.0 (the operations and shapes are unchanged): the core cancels a
  checkpointed task whenever it cuts a call off, its own timeout included (`TimeoutError` reason), and only then;
  forgets a cancelled task's handle; keeps a member's reason under layer `member`; settles a `waiting` call with what
  it reported only; drops `usage` and `costUsd` that are not finite non-negative numbers.
