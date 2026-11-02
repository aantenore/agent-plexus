# Host hooks

Version 0.1.

Control and insight are not layers of agent-plexus. They come from a **host** through four hooks. The core calls them
for every member call and never implements them beyond the prototype defaults below. A host is the object
`{ name, tier, gate, telemetry, score?, state? }`; it is passed to `assemble(config, { host })`, or built by a
configured `host` adapter that fills `Host`.

| Hook | Required | Prototype default | Production |
| --- | --- | --- | --- |
| [`gate`](#gate) | yes | Allow every call, no token, no check | Required; errors are a deny |
| [`telemetry`](#telemetry) | yes | One line per hop on stderr | Required |
| [`score`](#score) | no | `expected` checks only | Optional; without it the core applies the `expected` checks |
| [`state`](#state) | no | None | Optional |

`tier` is `prototype` or `production`. The readiness gate fails a production-tier profile whose host is a prototype
host. The `agent-layers` adapter builds a host from a stack: `gate` from its AuthorizationPort, ApprovalPort,
CredentialPort and GuardPorts, `telemetry` from its TelemetryPort, `score` from its EvaluatorPorts. It provides no
`state`: agent-layers' StatePort is an append-only event log per session, not a key/value store. Another host is
another adapter of the same four hooks.

## gate

Authorization, credentials and content checks for every member call, and authorization of a resume.

### Operations

- `allow(question: GateQuestion) → GateDecision`
  May this caller invoke this member, or continue this run? `GateQuestion` is one of
  `{runId, sessionId?, caller?, action: "invoke", member: AgentEntry, answer?: GateAnswer}` and
  `{runId, sessionId?, caller?, action: "resume", owner?: CallerIdentity, member?: AgentEntry, answer?: GateAnswer}`;
  `GateAnswer` is `{approved, reason?, by?}`; `GateDecision` is `{effect: "allow" | "deny" | "ask", reason?}`.
- `token(caller: Caller?, audience: String) → String?`
  A credential for the member's audience, on behalf of the caller. Absent when none is needed.
- `check(check: GateCheck) → GateVerdict`
  Is this text acceptable? `GateCheck` is `{stage: "send" | "receive", text, member: AgentEntry, runId, sessionId?, caller?}`;
  `GateVerdict` is `{action: "allow" | "block" | "redact", text?, reason?}`. `text` is required for `redact`.

### Semantics

- Called for every member call, in the order of the [pipeline](../docs/architecture.md#the-membercall-pipeline):
  `allow`, `check` on `send`, `token`, then after the call `check` on `receive` (completed results only).
- `ask` ends the call as `waiting` with code `needs_input`; any effect other than `allow` or `ask` is a deny.
- `System.resume(runId, {approved, reason?})` answers an `ask`: the call is made again and `allow` gets the same
  question plus `answer`, with `caller` set to who resumes and `answer.by` to that caller's id. The host decides again
  (allow, deny or ask); the core never takes an approval as a permission by itself. A host whose approvals live
  elsewhere (the `agent-layers` host reads its ApprovalPort) may ignore `answer`.
- Action `resume` is asked before a resume delivers anything: by `System.resume`, and by `run` with the id of a run the
  journal knows when its caller is not the run's owner. `caller` is who resumes, `owner` the identity of the caller
  that started the run (`{id, kind, name?, actors?}`, absent when it started without one), `member` the member the run
  waits on (absent when it waits on none or cannot describe itself), and `answer` the approval the resume gives, if
  any. `allow` lets the resume go on; `deny` stops it `stopped`, code `denied`, layer `host`; `ask` returns it
  `waiting`, code `needs_input`, layer `host`. In both cases the run stays as it was. A `run` or `resume` of a run
  that another invocation holds is refused before the gate is asked (see [ExecutionPort](ports/ExecutionPort.md#hold)),
  as is a resume whose `wait` token names another wait. The prototype host allows a
  resume only when the resumer is the owner (same `id`, `kind` and `actors`; two absent callers are the same) and
  denies anyone else with "only the caller that started the run may resume it".
- `redact` replaces the text that goes on. A verdict that is not one of the three actions, or a `redact` without
  `text`, is a block.
- `token` is called only for a member with an `audience`. A failure is `needs_auth`. A production-tier host that
  returns no token for an audience also stops the call with `needs_auth`; a prototype host may return none.
- The caller reaches the hook without its `credential`. A token returned for a member is never the caller's own.
- `reason` is internal; the core records it as the `detail` of the stop reason and never shows it to a caller (the CLI
  leaves `detail` out of its JSON output).

### Errors

An error thrown by `allow` is a `denied`; by `check` a `guard_block`; by `token` a `needs_auth`. The host fails closed.

## telemetry

Spans, events and metrics. The core names everything `plexus.*` and sets `plexus.layer` on every span.

### Operations

- `span(name: String, attrs: Attributes, fn: (span: SpanHandle) → T) → T`
  Runs `fn` inside a span and returns its result. `SpanHandle` has `set(attrs)` and `event(name, attrs?)`.
- `event(name: String, attrs: Attributes)`
- `metric(name: String, value: Number, attrs: Attributes)`

`Attributes` is `{String: String | Number | Boolean | [String] | absent}`.

### Semantics

- The names are in [language.md](language.md#telemetry-names). The trace context in `RunContext.trace` is opaque to the
  core; the hook that wrote it owns its format.
- Credentials never appear in attributes.
- The prototype default prints `plexus.hop member=<id> status=<status> code=<code or -> ms=<n>` for each hop span, on
  stderr. The CLI turns it off and prints hop lines from the run record instead.

## score

### Operations

- `score(evalCase: EvalCase, result: SystemResult, ctx?: ScoreContext) → [Score]`
  `ScoreContext` is `{read?(key: String) → String?}`: it reads a text the execution journal stored, by the key a hop
  record carries (`inputRef`, `outputRef`), so any host can check member outputs. Absent when the execution adapter
  has no `read`.

### Semantics

- Scores are in [0, 1]. A score with `member` set speaks about one member; [attribution](ports/AttributionPort.md)
  reads it.
- A host without `score` gets the built-in checks below from `System.score` (core `expectedScores`), never an empty
  list: a case with expectations is not passed unchecked.
- The prototype default checks the `expected` fields of a case only: `expected.output` (`equals`, `contains`, `matches`
  on the system output, metric `expected.output`) and `expected.members.<id>` (the member was called, `status`, and
  `contains` / `matches` on its stored output, metric `expected.member`). Without a stored text a text expectation
  fails with `output unavailable`. Each score is 1 or 0, with `reason: "failed: …"` naming the checks that failed.
- agent-plexus adds attribution across hops, not another scorer.

## state

### Operations

- `get(key: String) → Any`, `set(key: String, value: Any)`, `delete(key: String)`

### Semantics

Key/value storage a host offers. No default exists: ExecutionPort keeps its own journal. It is used by the planned
`host-execution` adapter, which stores the journal there. The `agent-layers` host does not provide it.

## Conformance

`checkHost` in [`@agent-plexus/conformance`](../packages/conformance) checks a host: rules H1-H9 (tier, gate
decisions, resume by the owner only, tokens, checks, telemetry, scores, state).

## Version history

- 0.1.0: initial.
