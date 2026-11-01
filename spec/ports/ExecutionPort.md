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
- `end(status: runStatus) → ()`
  Mark the run ended.

## Data shapes

`runStatus` is in [the language](../language.md#vocabularies). Keys are opaque strings.

## Semantics

- The core calls `begin` with the run id, `step` once per member call (name `call:<node path>:<index>`), `put` for the
  text sent to and received from a member, and `end` with the final status. It does not call `wait` or `signal` yet.
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
`read` agree; a resumed run returns the same results.

## Version history

- 0.1.0: initial.
