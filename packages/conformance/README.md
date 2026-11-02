# @agent-plexus/conformance

Conformance suites for the [agent-plexus](https://github.com/aantenore/agent-plexus) ports and host hooks: one suite
per port that proves an adapter behaves as its [port page](https://github.com/aantenore/agent-plexus/tree/main/spec/ports)
says.

```bash
npm install --save-dev @agent-plexus/conformance @agent-plexus/core
```

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-plexus/conformance';
import { adapter } from '../src/index.ts';

test('adapter passes conformance', async () => {
  const report = await checkAdapter(adapter, { options: { greeting: 'Hi' }, fixtures: { inputs: ['hello'] } });
  assert.deepEqual(report.failures, []);
});
```

`checkAdapter(descriptor, { options, fixtures, ctx })` checks the descriptor (D1, D2), creates the adapter with
`options` the way `assemble` does (D3: options schema and limits) and runs the suite of what it fills; it closes the
instance. `conformance(fills, instance, fixtures)` runs one suite on an instance. The suites never throw: a report lists
`failures`, `skipped` (checks that need a fixture or an operation the adapter does not have), `warnings` (notes that
fail no rule, such as a deprecated `ext` key) and the `rules` evaluated.

Every failure starts with the id of the rule it breaks. A known gap of an adapter is marked in its test, without
weakening the rest:

```ts
test('passes ExecutionPort conformance', async (t) => {
  const report = await checkAdapter(adapter, { options });
  assert.deepEqual(failuresExcept(report, 'E14'), []);
  await t.test('E14: close settles the pending waits', { todo: 'close leaves pending waits' }, () => {
    assert.deepEqual(failuresOf(report, 'E14'), []);
  });
});
```

## Suites

| Fills | Suite | Fixtures |
|---|---|---|
| ExecutionPort | `checkExecution` | `reopen` (durable), `secondInstance`, `exclusive`, `lease`, `alive` |
| TopologyPort | `checkTopology` | `kinds` (default: the adapter's `kinds`) |
| MemberPort | `checkMember` | `inputs`, `wait`, `reply`, `slow`, `checkpoint`, `promptMs`, `ctx` |
| RegistryPort | `checkRegistry` | `ids`, `filters`; the members come from `ctx.members` (default `SAMPLE_ENTRIES`) |
| AgentRouterPort | `checkRouter` | `cases` (`{ input, candidates?, expect? }`) |
| AttributionPort | `checkAttribution` | `cases` (`{ input, expect }`): the adapter's rules table |
| Host | `checkHost` | `member`, `denied`, `caller`, `other`, `othersMayResume`, `audience`, `block`, `score` |

A topology runs on fake members through `fakeScope`, a RunScope that records every call and route, and queues calls
beyond `maxParallel` as the core does. It is exported for an adapter's own tests.

## Rules

| Id | Rule |
|---|---|
| D1 | The descriptor passes the core's `checkDescriptor` and has an options schema |
| D2 | Every top-level limit (`options.<name>`) is described by the options schema |
| D3 | The adapter is created from `options`, validated as a system config would validate them |
| E1 | A step runs once and replays: in the same execution, after a new `begin`, after a restart (`reopen`) |
| E2 | Step results are JSON clones; `undefined` replays as `undefined`; a value JSON cannot hold rejects and stores nothing |
| E3 | A `fn` that throws stores nothing and the step rejects; a later call runs `fn` again |
| E4 | Concurrent calls of one step share one run of `fn` |
| E5 | The core's key formats (`call:root.steps[1]:0#1`, `<key>:task`, `<key>:reply:<n>`, `run:*`) and run ids of 128 characters |
| E6 | `fn` may call `recall` and `remember` on its run without a deadlock; a key kept as `null` recalls `null` |
| E7 | A signal before its wait is returned, also past the deadline; a later signal releases every pending wait; a deadline gives `undefined`; an invalid `untilAt` rejects |
| E8 | First signal wins: a second one is `false` before and after the wait; of two concurrent ones exactly one is `true`, also across instances; an unknown run rejects |
| E9 | `put` returns a new key per text; `read` returns it, also after the run ended; an unknown key is `undefined` |
| E10 | `remember` keeps a clone, a later one replaces it, `recall` returns a clone; runs are isolated; values survive `begin` and a restart; a value JSON cannot hold or an empty key rejects |
| E11 | `begin` resumes a run that ended, whatever its status, and resets nothing |
| E12 | An exclusive adapter rejects a second holder with `RUN_BUSY` until `end`, `release` or `close`; a hold expires; the old holder's writes are then refused |
| E13 | An adapter that can reject with `RUN_BUSY` implements `release`, which keeps the run as it was |
| E14 | A pending wait does not keep the process alive; `close` settles pending waits |
| T1 | `kinds` is a non-empty list of known kinds; `bind` rejects another kind, naming it and its path |
| T2 | Members only through `scope.call`, routers only through `scope.route`, both with a node path |
| T3 | Node paths follow the documented forms, differ between call sites, are the same on every run |
| T4 | Branches that finish in another order give the same result and the same calls |
| T5 | A waiting result passes through every supported kind with its `wait` unchanged |
| T6 | `route`: the chosen member with the decision, `failed` decisions, fallback, nobody; `handoff`: `optional` routing, ends on nobody, fails on `failed` |
| T7 | `loop`, `handoff` and `graph` stay within their bounds and stop with code `limit` |
| T8 | Concurrent calls pass shares that sum to at most 1; `join: "first"` aborts and abandons the other branches |
| T9 | Every result is valid; `input: "original"` gives a node the system's input |
| M1 | `describe` returns a valid entry, with trust booleans, the same each time |
| M2 | `invoke` returns a known status, a text output, a reason with a code unless completed, namespaced `ext` (the protocol keys `plexus.delegate` and `plexus.handoff` allowed; the bare `delegate` and `handoff` of 0.1.0 are warnings) |
| M3 | An aborted signal ends the call promptly, `stopped` with code `aborted`, before or during the call |
| M4 | The call's credential never appears in a result or an entry |
| M5 | A checkpointed `taskRef` is a non-empty string of at most 1024 characters; a member that checkpoints has `resume` |
| M6 | A waiting result has code `needs_input` or `needs_auth` and a handle; `resume` answers it |
| M7 | `cancel` settles once its signal fired |
| M8 | `usage` and `costUsd` are non-negative |
| M9 | The descriptor declares `capabilities`, and they match the instance |
| M10 | A result's `reason.layer`, when set, is `member`: a member's own layer name goes in `reason.memberLayer` |
| R1 | `list` returns valid entries, ids not repeated |
| R2 | `get` returns the entry `list` returns; an unknown id is `undefined` |
| R3 | Filters (`skills`, `tags`, `attrs`) behave as the spec says and are not changed |
| R4 | Every entry carries `trust` with booleans |
| R5 | `ext` keys are namespaced |
| A1 | A decision is an object naming a candidate or none |
| A2 | `ranked` lists only candidates, once each, with finite scores |
| A3 | `route` does not change the question (frozen) |
| A4 | `route` never reads the caller's credential |
| A5 | `reason` is a string; no candidates means no member; the `cases` table holds |
| At1 | An empty record of a completed run gives no attribution |
| At2 | An attribution has a valid layer, a confidence in [0, 1], evidence strings, `by`, and names hops of the record |
| At3 | Abandoned hops are skipped |
| At4 | `needs_input`, `needs_auth` and `aborted` give no attribution |
| At5 | Stored texts and `detail` never reach an attribution |
| At6 | Only `reason.code` drives: `detail` and `by` change nothing |
| At7 | A source that fails is ignored |
| At8 | The adapter's `cases` table holds |
| H1 | `name` is set and `tier` is `prototype` or `production` |
| H2 | `allow` answers `allow`, `deny` or `ask` for invoke questions |
| H3 | Only the owner resumes a run (same id, kind and delegates), unless the host says otherwise (`othersMayResume`) |
| H4 | A token is never the caller's own credential |
| H5 | `check` answers `allow`, `block` or `redact` with text; the `block` fixture is blocked |
| H6 | Telemetry never throws; `span` returns what `fn` returns and rejects with its error |
| H7 | Scores are in [0, 1] |
| H8 | `state` keeps and returns clones; a deleted key reads as `undefined` |
| H9 | An approved answer does not turn a deny into an allow |
| S1 | In a system: a run that waits, then a resume that answers it (on a system assembled again when durable) |
| S2 | In a system: a parallel run on a budget completes within it (skipped only when the topology adapter does not run `parallel`) |
| S3 | In a system: a run's record can be attributed |

## System level

`checkSystem(descriptor, { adapters, options, durable })` assembles the adapter under test with the reference
adapters given in `adapters` (a topology, an execution and an attribution, unless it fills one of them) and fake members,
then runs S1-S3. A MemberPort adapter runs as a member of that system.

How to write an adapter: [CONTRIBUTING.md](https://github.com/aantenore/agent-plexus/blob/main/CONTRIBUTING.md), starting
from [`adapters/_template`](https://github.com/aantenore/agent-plexus/tree/main/adapters/_template).

Requires Node >= 22.18. License: MIT.
