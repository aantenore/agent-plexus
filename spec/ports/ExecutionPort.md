# ExecutionPort

Layer: `execution` (L4 Execution) · Version: 0.1.0 · Conformance: planned

## Purpose

Keep the journal of a run so that a long run can survive a restart and wait for a person. Each member call is a step
that runs once and replays its stored result on resume.

## Operations

- `begin(runKey: String) → Execution`
  Start a run, or resume the existing run with that key (durable adapters; also one that ended `waiting`).
- `signal(runKey: String, name: String, value: Any) → ()`
  Release the waiters of `name` on a run; a signal that comes first is kept for the next wait.
- `read?(key: String) → String?`
  A stored text by key, for attribution, scoring and replay.

An `Execution` has:

- `step(name: String, fn: () → T) → T`
  Run `fn` once; on resume return its stored result. The result must be JSON-serialisable.
- `wait(name: String, untilAt: String) → Any`
  Suspend until `signal(runKey, name, value)` or `untilAt`; returns the value, or nothing at the deadline.
- `put(text: String) → String`
  Store a text and return its key.
- `remember(key: String, value: Any) → ()`
  Keep a small JSON value under a key for this run; the value is cloned through JSON and survives a restart when the
  adapter is durable. A later `remember` of the same key replaces it.
- `recall(key: String) → Any`
  The value kept under the key, cloned, or nothing. Keys of other runs are not visible.
- `end(status: runStatus) → ()`
  Mark the run ended.

## Data shapes

`runStatus` is in [the language](../language.md#vocabularies). Keys are opaque strings.

## Semantics

- The core calls `begin` with the run id, `step` once per member call (name `call:<node path>:<index>`), `put` for the
  text sent to and received from a member, and `end` with the final status. It does not call `wait` or `signal` yet.
- Inside each step the core calls `recall("<step name>:task")`, and `remember("<step name>:task", taskRef)` when the
  member checkpoints. The kept value stays after the step finishes and is read again only if the step has no stored
  result. A crash before the step result is stored therefore leaves the handle, and the next run of the same key
  continues the remote work (see [MemberPort](MemberPort.md#two-phase-call)). A failing `recall` fails the step.
- `remember` and `recall` are separate from `step`: they are not replayed from a result, so they belong to the run
  and not to a step attempt.
- A step whose function throws stores nothing. Concurrent calls of the same step share one run of the function.
- Step results and signal values are cloned through JSON, so a replay returns exactly what a resume would.
- Hop records carry the keys of stored texts (`inputRef`, `outputRef`), never the texts.
- A prototype adapter may lose everything on restart; the readiness gate refuses it on a production tier.

## Errors

A failing `begin` makes the run `failed` with code `error`, layer `execution`. A failing `step` makes the call `failed`
with the same layer. A failing `put` or `end` is ignored: the result stands.

## Escape hatch

`native()` is not defined for this port. Adapter-specific data goes in step results, which must be JSON.

## Conformance

A `checkExecution` suite is planned. It will verify: a step runs once and replays; a signal releases a wait; `put` and
`read` agree; a value kept with `remember` is recalled, also by a resumed run; a resumed run returns the same results.

## Version history

- 0.1.0: initial; `remember` and `recall` added before release.
