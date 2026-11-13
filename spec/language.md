# The language

Version 0.1.

The data that crosses a port or a hook is written in one small language owned by this project: fixed and minimal at
the core, extensible through declared extensions. Frameworks and protocols appear only inside adapters, which
translate at the edges. Where a concept is the host's (a caller, a run status, a stop code), the values are equal to
those of agent-layers by choice, so an adapter maps them one to one. The reasoning is in
[ADR 0001](../docs/decisions/0001-own-ports-agent-layers-as-adapter.md); this page is the reference.

Four rules carry the rest:

1. A field enters a shape only when the core reads it, or when two or more adapters of different protocols need it.
   Everything else goes in `ext`.
2. Shapes and field names are fixed. Extra data goes in namespaced `ext` keys.
3. Protocols live in adapters. N protocols need N translations to the language, not N×M between them.
4. A concept the host owns (the caller, a verdict, a score) is carried without being interpreted.

JSON Schemas for these shapes are planned. Until then the definition is the tables below and
`packages/core/src/shapes.ts`.

## Naming rules

| Rule | Example |
| --- | --- |
| Short plain-English names, camelCase fields | `inputTokens`, `hopId` |
| `type` only discriminates a union; `kind` classifies | `{ "type": "text" }`, `caller.kind`, `topology.kind` |
| Times are ISO 8601 strings named `at` or `<x>At`, or durations in `…Ms` | `deadlineAt`, `startedAt`, `durationMs` |
| Identifiers are `id` or `<x>Id` | `runId`, `hopId`, `rootRunId` |
| Telemetry names start with `plexus.` | `plexus.hop` |
| No name that belongs to one protocol | `taskRef`, not a wire-format field name |

## Shapes

Every shape has an optional `ext` unless noted. Required fields are marked; the others are optional.

| Shape | Used by |
| --- | --- |
| `RunInput` | [MemberPort](ports/MemberPort.md), [AgentRouterPort](ports/AgentRouterPort.md), [TopologyPort](ports/TopologyPort.md) |
| `Caller` | the run context, [`gate`](hooks.md#gate) |
| `Bounds`, `OutboundBounds`, `Lineage` | the run context, [MemberPort](ports/MemberPort.md) |
| `RunContext` | every port that acts inside a run |
| `MemberResult`, `StopReason`, `Usage` | [MemberPort](ports/MemberPort.md), [TopologyPort](ports/TopologyPort.md) |
| `AgentEntry`, `Skill`, `CandidateFilter` | [RegistryPort](ports/RegistryPort.md), [MemberPort](ports/MemberPort.md) |
| `RouteQuestion`, `RouteDecision` | [AgentRouterPort](ports/AgentRouterPort.md) |
| `TopologySpec`, `Condition` | [TopologyPort](ports/TopologyPort.md) |
| `HopRecord` | [AttributionPort](ports/AttributionPort.md), `SystemResult` |
| `Score`, `EvalCase` | [`score`](hooks.md#score), [AttributionPort](ports/AttributionPort.md) |
| `Attribution` | [AttributionPort](ports/AttributionPort.md) |
| `SystemResult` | `System.run`, `System.resume`, `System.cancel` |
| `ResumeReply` | `System.resume` |
| `CancelOptions` | `System.cancel` |

### RunInput

A string, or `{ text, parts? }`. A string is shorthand for `{ text }`. A part is `{ type: "text", text }` or
`{ type: "media", mediaType, url?, data? }`. Only `text` crosses to a member: the gate checks text alone, so `parts`
are dropped by the pipeline and a `plexus.parts.dropped` event is emitted.

### ResumeReply

The answer to a run that ended `waiting`, given to `System.resume(runId, reply, ctx?)`: `{ input: RunInput }` for a
member that waits for input, or `{ approved: Boolean, reason?: String }` for the host's `ask`, each with an optional
`wait: String`. Exactly one of `input` and `approved`; a reply of the other kind than the wait is refused (`failed`,
code `error`, layer `execution`). `wait` is the token of the wait the reply answers (`SystemResult.wait.token`): when
the run now waits elsewhere the resume is refused ("run <id> waits on another step") and delivers nothing, so a late
or repeated reply never answers a later wait. Without `wait` the reply answers whatever the run waits on. The host's
gate is asked `resume` first (see [hooks](hooks.md#gate)): a resume by anyone the gate does not allow is `stopped`,
code `denied`, layer `host`, and delivers nothing. A resume while another invocation runs the run is `failed`, code
`error`, layer `execution` ("run <id> is in progress"). One reply per wait, the first delivered wins: a reply already
delivered by a resume that did not finish answers the wait, and the new one is not used. An approval is kept with
`by`, the id of the caller that resumed.

### CancelOptions

Given to `System.cancel(runId, opts?)`: `{ by?: Caller, reason?: String, signal?: AbortSignal }`. `by` is who cancels (the
gate is asked `cancel` with it, never with its credential, see [hooks](hooks.md#gate)); `reason` is kept with the run
as the `detail` of its stop reason. The result is a `SystemResult` without records. A run that is not over (waiting, or
left unfinished by an invocation that died) is closed: the member it waits on is asked to cancel its remote task, best
effort, and the run ends `stopped`, code `cancelled`, layer `execution`, with `by` the id of the caller; it is kept
as `run:cancelled`, and a `run` or `resume` of it is refused afterwards (`failed`, code `error`, "run <id> was
cancelled"). Cancelling a cancelled run returns that result again. Refusals leave the run as it was: `failed`, code
`not_found` (the journal has no such run), `conflict` (the run already completed, failed or stopped), `error` (invalid
run id, or "run <id> is in progress" while another invocation holds the run), `stopped`/`aborted` (the signal was
aborted first), and the gate's `denied` and `needs_input`.

### Caller

The host's verified caller, carried through. The core reads only `id`, `kind` and `actors`.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Caller identifier. |
| `kind` | `user` or `agent`, required | |
| `roles`, `scopes` | [String], required | As the host verified them. |
| `name?` | String | |
| `actors?` | [`{id, kind, name?, issuer?}`] | Agents that acted for the caller, first delegate first, as the host verified them. `issuer` names who vouches for an entry when it differs from the credential's issuer; the core does not read it. |
| `credential?` | String | In memory only: never serialised, logged or traced. The pipeline strips it before any port sees the caller. |

A `CallerIdentity` is `{id, kind, name?, actors?}`: who a caller is, without roles, scopes, `ext` or credential. A run
keeps the identity of the caller that started it as its owner. Two identities are the same when `id`, `kind` and the
`actors` (id and kind, in order) are equal; two absent callers are the same.

### Bounds, lineage and the run context

| Shape | Fields | Notes |
| --- | --- | --- |
| `Bounds` | `deadlineAt` (ISO 8601, local clock), `hops`, `maxHops`, `tokens?`, `costUsd?` | What a run works within. Same fields and rules as the [agent-layers proposal](../docs/proposals/agent-layers-delegation-bounds.md). |
| `Lineage` | `rootRunId`, `parentRunId` | |
| `OutboundBounds` | `remainingMs`, `hops`, `maxHops`, `tokens?`, `costUsd?`, `rootRunId`, `parentRunId` | What crosses to the next agent: time as remaining milliseconds, never as a clock time. |
| `RunContext` | `runId`, `system`, `caller?`, `bounds?`, `lineage?`, `sessionId?`, `signal?`, `trace?` | `bounds` are the host's; the core tightens them with the system's limits. `trace` is `{parent, state?}`, opaque to the core and owned by the telemetry hook. |

The deadline of a run is the earlier of the host's `deadlineAt` and now plus `limits.system.timeoutMs`. Hops and budget
are the host's; without `maxHops` the run may add `limits.system.maxDepth` hops. Bounds can be tightened, never raised.

### MemberResult

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `completed`, `failed`, `stopped` or `waiting`, required | |
| `output` | String, required | Final text. Empty when there is none. |
| `reason?` | [StopReason](#stop-reasons) | Required when `status` is not `completed`; the pipeline adds `{code: "error", layer: "member"}` when a member omits it. |
| `runId?` | String | The member's own run id. |
| `taskRef?` | String | Opaque handle to resume or cancel the member's work (an A2A task and context). |
| `usage?` | `{inputTokens, outputTokens}` | |
| `costUsd?` | Number, >= 0 | Present when the member reports it; absent means unknown, and the budget treats it as fully spent (on a `waiting` result: as nothing spent yet, the continuation settles the rest). A value that is not a finite non-negative number is dropped by the core. |
| `wait?` | `WaitRef` | On a `waiting` result of a member call only, set by the core: the wait a resume answers. A member's own is dropped; a topology passes it on with the result. |
| `ext?` | Ext | |

A `WaitRef` is `{token, kind, member}`: `token` is `<step key>#<attempt>` of the call that waits (`call:<node
path>:<n>#<attempt>`, opaque to a caller), `kind` is `input` for a member that waits (`needs_input`, `needs_auth`) or
`approval` for the host's `ask`, and `member` the member id. It carries no text.

A `SystemResult` is a `MemberResult` plus `runId` and `record: [HopRecord]`, so a system can be a member of another.
Its `wait` is present exactly when it is `waiting` on a wait the run keeps, and names that wait. Its `usage` and
`costUsd` are the core's totals over the records of the invocation that are not `replayed`.

### AgentEntry

| Field | Type | Meaning |
| --- | --- | --- |
| `id`, `name`, `description` | String, required | The id is the member id in the config; the core sets it. |
| `skills` | [`{id, name, description, tags}`], required | |
| `endpoint` | `{protocol, url?, ref?}`, required | `protocol` is a vocabulary: `function`, `a2a`; adapters add values. |
| `audience?` | String | Credential audience. From config, never from a card. |
| `attrs?` | Attrs | Plain attributes a filter may read. |
| `trust` | `{signed, keyId?, pinned}`, required | |
| `version?` | String | |

`CandidateFilter` is `{skills?, tags?, attrs?}`. `Attrs` is `{String: String | Number | Boolean | [String]}`.

### Routing

`RouteQuestion` is `{input, candidates: [AgentEntry], caller?, bounds?}`. `RouteDecision` is
`{member?, ranked?: [{member, score}], reason?, failed?: true}`. No `member` means no candidate fits. `failed` is set by
the core when routing failed (the router or the registry threw, or the router chose outside the candidates), which is
not the same as choosing nobody; `reason` then carries the error. `reason` is internal text, never parsed.

### HopRecord

One per member call, written for every call including refusals, and one for a route that chose nobody or failed (no
`member`).

| Field | Type | Meaning |
| --- | --- | --- |
| `hopId`, `member`, `node`, `rootRunId`, `hops`, `startedAt`, `durationMs`, `status` | required | `member` is empty for a route that chose nobody (`stopped`, `rejected`) or failed (`failed`, `error`). `node` is the topology path, such as `root.steps[1]`. |
| `parentHopId?`, `runId?`, `reason?`, `usage?`, `costUsd?` | | |
| `route?` | `{member?, ranked?}` | The router's decision that chose this member. |
| `inputRef?`, `outputRef?` | String | Keys of the texts in the execution journal. Records never carry the texts. |
| `inputFrom?` | [String] | Hop ids whose output was this hop's input, as the topology passed them in `CallOptions.inputFrom`. Empty: the input was the caller's and no hop produced it. Absent: the topology did not say. |
| `abandoned?` | Boolean | The topology abandoned the branch (a `parallel` with `join: "first"`). |
| `attempt?` | Integer, >= 1 | The call was continued by `System.resume`: 1 after the first resume. Absent on the first attempt. |
| `replayed?` | Boolean | The call's journal step replayed: an earlier invocation of the run made the call and spent its `usage` and `costUsd`, which stay on the record but are not counted again in this invocation's result. |

### Score, EvalCase, Attribution

| Shape | Fields |
| --- | --- |
| `Score` | `metric`, `value` in [0, 1], `member?` (set when the case expected something of one member), `reason?` |
| `EvalCase` | `id`, `input`, `expected?: {output?: {equals?, contains?, matches?}, members?: {<id>: {contains?, matches?, status?}}}`, `tags?` |
| `Attribution` | `layer` (a plexus layer id or `host`), `member?`, `memberLayer?`, `hopId?`, `confidence` in [0, 1], `evidence` [String], `by` |

## Vocabularies

A vocabulary is a set of values defined by the project. The core branches only on core values.

| Vocabulary | Core values | Extensible | Used by |
| --- | --- | --- | --- |
| `layer` | `member`, `registry`, `routing`, `topology`, `execution`, `attribution` | no | everything; `Attribution.layer` also allows `host` |
| `runStatus` | `completed`, `failed`, `stopped`, `waiting` | no | `MemberResult.status` |
| `stopCode` | `guard_block`, `denied`, `aborted`, `timeout`, `limit`, `hop_limit`, `needs_input`, `needs_auth`, `rejected`, `error` | other strings pass through; `like` values planned | `StopReason.code` |
| `callerKind` | `user`, `agent` | no | `Caller.kind` |
| `protocol` | `function`, `a2a` | adapters add values | `AgentEntry.endpoint.protocol` |
| `gateEffect` | `allow`, `deny`, `ask` | no | [`gate.allow`](hooks.md#gate) |
| `gateStage` | `send`, `receive` | no | [`gate.check`](hooks.md#gate) |
| `gateAction` | `allow`, `block`, `redact` | no | [`gate.check`](hooks.md#gate) |
| `kind` | `sequence`, `parallel`, `route`, `loop`, `handoff`, `supervise`, `graph` | no | `TopologySpec.kind` |

Vocabulary extension through config (`vocabularies`, with `like` values) is planned; the config schema does not accept
the block yet.

## Stop reasons

`StopReason` is `{code, layer?, memberLayer?, by?, stage?, detail?}`. Consumers branch on `code` only.

| Field | Meaning |
| --- | --- |
| `code` | One of the stop codes below. |
| `layer?` | Where it stopped: a plexus layer id or `host`. A value that is neither is read as `memberLayer` (the form used before that field). |
| `memberLayer?` | The member's own name for where it stopped, a layer of its own stack. Never compared with plexus layer ids, so a member layer named like one (`routing`) is not taken for it. |
| `by?` | The instance that stopped it: a host name, a limit path such as `limits.system.maxSteps`. For people and telemetry. |
| `stage?` | `send` or `receive`, for a gate check. |
| `detail?` | Internal text. Never parsed, never shown to a caller: the CLI leaves it out of its JSON output, in the `reason` of the result and in every `reason` of the record. |

| Code | Meaning | Where it comes from |
| --- | --- | --- |
| `guard_block` | The host's check blocked the text | `gate.check`, layer `host`, with `stage`; or a member |
| `denied` | The call is not allowed | `gate.allow`, layer `host` (also a `resume` the host refuses); with `registry.requireListed`, a member the registry does not return, layer `registry` |
| `aborted` | The run was cancelled | the signal of the run or of a branch |
| `timeout` | A deadline passed | layer `topology` (run deadline, `by` names who set it) or `member` (`limits.system.stepTimeoutMs`) |
| `limit` | A system limit stopped the call | layer `topology`, `by` names the limit; or a member's own limit |
| `hop_limit` | The chain is too deep | layer `topology` |
| `needs_input` | The run waits for a person | `gate.allow` returned `ask` (also for a `resume`), or a member |
| `needs_auth` | No credential for the member's audience | `gate.token`, layer `host`; or a member |
| `rejected` | A remote member declined or stopped | a member; over A2A today every remote stop except a cancellation; layer `member` for a resume with input to a member without `resume` or without a kept task handle |
| `cancelled` | `System.cancel` closed the run | layer `execution`; the result of `System.cancel` |
| `not_found` | The journal has no such run | `System.cancel`, layer `execution`, status `failed` |
| `conflict` | The run is already over | `System.cancel` of a completed, failed or stopped run, layer `execution`, status `failed` |
| `error` | Something failed | a member that threw or answered an unknown status; the topology; routing, layer `routing`, when the router or the registry failed; the journal, also a `System.resume` of a run that is not waiting or waits on another step, a `run` or `resume` of a run in progress, a run whose owner or input could not be kept, and a `run` with the id of a known run and a different input |

## Extensions (`ext`)

`ext` is the one escape hatch for data. The operation escape hatch, `native()`, stays where a port offers it.

| Rule | Detail |
| --- | --- |
| Shape | `ext?: { [key]: JSON value }`. JSON values only. |
| Keys | `<adapter>.<name>`; the namespace is the adapter name. |
| Who writes | The adapter that produces the shape, only keys in its own namespace. |
| Protocol keys | `plexus.` is the core's namespace, reserved. A member writes two of its keys to steer the topology: `plexus.delegate` (`{ member, input? }`, for `supervise`) and `plexus.handoff` (a member id, for `handoff`). No other `plexus.` key may be written. The bare `delegate` and `handoff` of 0.1.0 are deprecated: `basic-topology` still reads them (the `plexus.` key wins when both are set), and the conformance kit reports them as warnings, not failures. |
| Core | Copies `ext` unchanged wherever a shape passes through. Never reads, branches on, logs or traces an adapter key. A `Condition` may test an `ext` value. |

Declaration of `produces` / `reads` in the adapter descriptor is planned. The conformance suites already check that the keys an adapter writes are namespaced.

## Condition

A condition is data. A result satisfies it when it satisfies every field set.

| Field | Meaning |
| --- | --- |
| `status?` | A run status or a list of them |
| `code?` | A stop code or a list; compared with `reason.code` |
| `ext?` | `{key: value}`; each key of the result's `ext` must be deeply equal |
| `matches?` | Regular expression on the output; an invalid pattern never matches |
| `fn?` | `"<module>#<export>"`: a synchronous pure function `(result) => boolean`, loaded relative to the config file |

## TopologySpec

A node is a member id or a nested `TopologySpec`; every kind is bounded. Every kind takes `name?`, `input?`
(`"output"`, the default, or `"original"`) and `ext?`.

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `sequence` | `steps: [Node]` | Each step gets the previous step's output. Must not be empty. |
| `parallel` | `branches: [Node]`, `join?: "all" \| "first"`, `merge?: Node` | Fan out and join; with `first`, the other branches are cancelled. |
| `route` | `candidates: [String] \| {skills?, tags?, attrs?}`, `router?: String`, `fallback?: Node` | The AgentRouterPort picks one; none chosen runs `fallback` or stops with `rejected`. |
| `loop` | `body: Node`, `until: Condition`, `maxIterations?: N` | Bounded by `limits.system.maxIterations` by default. |
| `handoff` | `start: String`, `members: [String]`, `router?: String`, `maxHandoffs?: N` | After each answer the member (`ext["plexus.handoff"]`) or the router picks the next member, or it ends. |
| `supervise` | `supervisor: String`, `members: [String]` | The supervisor is called with the node input; it names the member to call with `ext["plexus.delegate"] = { member, input? }` and is called again with the member's output, until it answers without it. Bounded by `limits.system.maxHandoffs`. |
| `graph` | `nodes: {id: Node}`, `start`, `edges: [{from, to, when?: Condition}]`, `end: [String]` | Explicit state machine. |

The config schema checks the shape of every kind; whether members and routers exist, and whether the topology adapter
runs the kind, is checked by `agent-plexus check`. A router name defaults to `router`.

## Telemetry names

The core names its spans, events and metrics `plexus.*` only, and sets `plexus.layer` on every span.

| Kind | Name |
| --- | --- |
| span | `plexus.run`, `plexus.hop`, `plexus.route`; `plexus.node` is declared but not emitted yet |
| attribute | `plexus.layer`, `plexus.system`, `plexus.member`, `plexus.hop`, `plexus.node.path`, `plexus.node.kind`, `plexus.route.choice`, `plexus.run.id`, `plexus.run.status`, `plexus.run.reason`, `plexus.parts.count`, `plexus.execution.key`, `plexus.error.message`; `plexus.node.kind` is declared but not emitted yet |
| event | `plexus.run.cancelled` (`System.cancel` closed a run: the run id, `stopped`, `cancelled` and the member it waited on), `plexus.limit`, `plexus.parts.dropped`, `plexus.member.resumed`, `plexus.checkpoint.ignored`, `plexus.execution.write_failed` (a value the core keeps, or the run's `end` or `release`, could not be written: the key and the error, never the value), `plexus.execution.reply_kept` (a resume went on with the reply an earlier resume delivered), `plexus.execution.wait_inferred` (a `waiting` result named no wait of the run: the latest is kept), `plexus.member.cancel_failed` (a `cancel` of an abandoned or cut-off call threw or outlived `limits.system.cancelTimeoutMs`), `plexus.member.figure_dropped` (a member's `usage` or `costUsd` was not a finite non-negative number and was dropped) |
| metric | `plexus.hops`, `plexus.attributions` |

Credentials never appear in attributes.
