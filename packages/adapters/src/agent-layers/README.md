# @agent-plexus/adapters/agent-layers

Maps **an agent-layers stack** → **Host** and **MemberPort**, and **an agent-plexus system** → the **RuntimePort** of an
agent-layers stack. Tier: prototype, production. Maturity: experimental.

The only adapter that depends on agent-layers: `@agent-layers/core` ^0.4.0, an optional peer dependency of
`@agent-plexus/adapters` (`npm install @agent-layers/core`). It has three parts:

| Part | Fills | Entry point |
|---|---|---|
| Host `agent-layers` | agent-plexus `Host` | `@agent-plexus/adapters/agent-layers` |
| Member `agent-layers` | agent-plexus `MemberPort` | `@agent-plexus/adapters/agent-layers` |
| Runtime `agent-plexus` | agent-layers `RuntimePort` (layer `harness`) | `@agent-plexus/adapters/agent-layers/runtime` |

The two entry points are separate modules, so each loader sees only its own descriptors: agent-plexus reads `adapters`
of the main entry, an agent-layers config loads the runtime as a plugin.

## Host

Composes the stack of an agent-layers config once (`loadConfig` and `compose`) and builds the host hooks from it. The
host tier is `production` when the stack's profile is production-tier, else `prototype`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `config` | string | required | agent-layers config file, relative to the directory of the system config |
| `profile` | string | the config's | agent-layers profile |
| `agent` | string | the system name | Agent name in guard checks and access questions (`agent-plexus` when a host is built in code with `hostFromStack` without one) |
| `risk` | object | `{}` | Risk of calling each member, by member id: `read`, `write`, `exec` or a value of the stack's `risk` vocabulary; `exec` when absent |
| `approve` | string[] | `[]` | Members whose calls ask for approval after authorization allowed them |

```json
{
  "host": {
    "adapter": "agent-layers",
    "options": { "config": "../agent-layers/agent-layers.json", "profile": "production", "risk": { "billing": "write" }, "approve": ["billing"] }
  }
}
```

| Hook | Built from | Behaviour |
|---|---|---|
| `gate.allow` | AuthorizationPort, ApprovalPort | Asks the authorization adapter `{ caller, action: "call", target: { kind: "agent", id: <member>, layer: "harness", risk, agent, attrs } }`. The caller is the public caller (no credential) or the explicit anonymous caller. Not allowed or an error is a deny. No authorization adapter: deny on a production tier, allow on a prototype tier |
| `gate.allow`, resume | AuthorizationPort | A resume (`action: "resume"`) by anyone but the run's owner (same `id`, `kind` and `actors`) is denied without asking the stack. For the owner it asks the authorization adapter the call's question with `action: "resume"` (exported as `RESUME_ACTION`, a core value of the `action` vocabulary) and the owner's identity under `ext["agent-plexus.owner"]`; a run that waits on no member is asked about as `target: { kind: "run", id: <run id> }`. Not allowed or an error is a deny; no authorization adapter: as above. No approval is asked. `rules-authorization` matches a rule without `actions` to `call` only and denies any other action no rule names: write rules with `actions: ["resume"]` (the same `tools` as the call rules, so a resume is allowed for the owner exactly when calling the member is). Without one, every resume is denied |
| `gate.allow`, cancel | AuthorizationPort | A cancel (`action: "cancel"`, `System.cancel`) is handled as a resume: anyone but the run's owner is denied without asking the stack; for the owner the authorization adapter is asked the same question with `action: "cancel"` (exported as `CANCEL_ACTION`). `rules-authorization` needs rules with `actions: ["cancel"]`, as for `resume`; without one, every cancel is denied |
| `gate.allow`, approval | ApprovalPort | For a member in `approve` that was allowed: a decision already taken for the same caller, member, agent and system run is used first (approved allows once, denied denies); otherwise an approval is requested and the call is `ask` (the run is `waiting`, `needs_input`, wait kind `approval`) until a person decides. No approval adapter: deny |
| `gate.allow`, answer | ApprovalPort | A call a person answered through `System.resume` (`{ approved, reason? }`, the resumer being the run's owner): the pending approval of the call, found with `lookup`, is decided with `decide(id, { approved, by: <resumer id>, reason })`. A decision already taken elsewhere stands. A denial denies; an approval allows the call once (it is consumed). An approval adapter without `lookup` gives no approval id: an approving answer asks again, a denying one denies |
| `gate.token` | CredentialPort | `credentials.token(audience, { caller })` with the plexus caller mapped to the agent-layers caller, credential included. No credential adapter: no token |
| `gate.check` | every GuardPort | The guard context carries the run id and session of the call. `send` runs the guards of stage `tool_args`, `receive` those of `tool_result`, in order, through the stack's own guard runner (spans and metrics included). The first block is a block; a redaction carries its text on; a failing guard is a block that does not echo the error |
| `telemetry` | TelemetryPort fan-out | Spans, events and metrics keep their `plexus.*` names and attributes and gain `agent.layer: "harness"` |
| `score` | EvaluatorPort adapters | Present when the stack has evaluators. The case becomes an agent-layers case (`expected` is the expected output text: `equals`, else `contains`, else `matches`; the whole expectation is under `ext["agent-plexus.expected"]`), the result an `EvalRun`; scores come back as `{ metric, value, reason }`. The evaluators see the system's output only: `expected.members` is checked by the host itself on the member texts the core reads back (`expected.member` scores, as the built-in checks) |
| `state` | StorePort | Present when the stack configures a store (`layers.store`). `get`, `set` and `delete` on keys `plexus.<key>` (exported as `STATE_NAMESPACE`), so they cannot collide with other components sharing the store. A value must be JSON; a write the store refuses is an error. No store: no `state` |

`state` is not built on agent-layers' StatePort: that is an append-only event log per session, not a key/value store.

Closing the system closes the stack.

## Member

Offers an agent of a composed stack as a member. One stack per member instance. Declared `capabilities`: `waits`, and
`resume` and `cancel` when the installed agent-layers has run control (0.4.0 on: `Stack.resume`, `Stack.cancel`); no
`checkpoint`. Each member detects run control on its own stack: with an older stack it has neither method, a waiting
run names no task, and the readiness gate warns that a run waiting on this member cannot continue (the approval it
waits for is decided through the stack's approval routes, and the call is made again).

| Option | Type | Default | Meaning |
|---|---|---|---|
| `config` | string | required | agent-layers config file, relative to the directory of the system config |
| `profile` | string | the config's | agent-layers profile |
| `agent` | string | required | Agent of the stack this member runs; an unknown agent is refused at creation |
| `description` | string | `""` | What the member does |
| `skills` | object[] | none | `{ id, name?, description?, tags? }` |
| `tags` | string[] | none | Tags of one `default` skill, used when `skills` is not set |
| `attrs` | object | none | Attributes for registry filters |
| `audience` | string | none | Credential audience |

```json
{
  "members": {
    "assistant": { "adapter": "agent-layers", "options": { "config": "./agent-layers.json", "agent": "assistant", "tags": ["support"] } }
  }
}
```

`describe()` returns endpoint `{ protocol: "agent-layers", ref: "<config>#<agent>" }` and trust `{ signed: false,
pinned: true }`. `invoke` runs `stack.agent(<agent>).run(text, …)` with the plexus caller (no credential; its `actors`,
`issuer` included, become the agent-layers caller's `actors`), the session, the abort signal, the trace context and, as
`delegation`, the call's outbound bounds (`remainingMs`, `hops`, `maxHops`, `tokens`, `costUsd`, `rootRunId`,
`parentRunId`). The stack runs within them: they can only tighten its own `limits.run`, it refuses a run over the hop
limit or with too little time left, and its model calls are refused once the deadline or the budget is reached. When the
pipeline gave the member a credential for its audience, it becomes the caller's credential. The run result maps one to
one:

| agent-layers `RunResult` | `MemberResult` |
|---|---|
| `status`, `output`, `runId`, `usage`, `costUsd` | the same; `usage` and `costUsd` settle what the call reserved |
| `reason.code`, `reason.by`, `reason.detail` | the same, `hop_limit`, `timeout` and `limit` of the stack's bounds included |
| `reason.layer` (an agent-layers layer id) | `reason.memberLayer`; `reason.layer` is `member` |
| `ext["sdk.approval"]` of a `waiting` run (`{ id, by?, tool? }`) | `ext["agent-layers.approval"]` (exported as `APPROVAL_KEY`) |
| `reason.stage`, `events`, other `ext` keys | not carried |
| `runId` of a `waiting` run, on a stack with run control | `taskRef` |

With run control, `resume(taskRef, input)` calls `stack.resume(runId, { input: <text> }, …)` with the same caller,
signal, trace and delegation as a run, and maps the result as above; the stack checks that the caller may resume the
run and continues it from its checkpoint. A run waiting for an approval continues once the approval is decided through
the stack (its approval routes); before that the stack refuses with `conflict`. Without input there is nothing to send
and no remote work to wait for: the call stops with `rejected`. `cancel(taskRef)` calls `stack.cancel(runId, { by,
signal })`; a run that is gone (`not_found`) is already over, any other refusal is thrown. A `RunRefused` of `resume`
becomes a result:

| `RunRefused.kind` | `MemberResult` (`reason.layer: "member"`, `detail: "<kind>: <message>"`) |
|---|---|
| `not_found`, `invalid` | `stopped`, `rejected`, `memberLayer: "harness"` |
| `forbidden` | `stopped`, `denied`, `memberLayer: "identity"` |
| `conflict` | `waiting`, `needs_input`, `memberLayer: "harness"`, the same `taskRef`: the run is left as it was |
| any other | `failed`, `error` |

Any other error of `resume` is thrown, as for `invoke`.

## Runtime

An agent-layers `RuntimePort` named `agent-plexus` (layer `harness`) that runs a system instead of a tool loop. Load it
as a plugin and name it in the `runtime` slot:

```json
{
  "plugins": ["@agent-plexus/adapters/agent-layers/runtime"],
  "agents": { "desk": { "model": "mock", "instructions": "Hand the request to the desk system." } },
  "layers": {
    "runtime": { "adapter": "agent-plexus", "options": { "system": "./plexus.json" } }
  }
}
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `system` | string | required | agent-plexus system config, relative to the directory of the agent-layers config |
| `profile` | string | the config's | agent-plexus profile |
| `risk` | object | `{}` | Risk of calling each member, by member id; same meaning as in the host adapter |
| `approve` | string[] | `[]` | Members whose calls ask for approval; same meaning as in the host adapter |

`bind` assembles the system on the first run of each agent, with a host built from the same stack (no second stack is
composed), so the stack's authorization, approval, credentials, guards, telemetry and evaluators govern every member
call of the system. The agent name of the host is the agent being run. A run passes the system its own run id (so the
guard checks, approvals and the system run share the id of the agent run), the caller (credential kept in memory, used
only to mint member tokens; `actors` with their `issuer`), session, abort signal, trace context, lineage and bounds, and
returns the result below.

The system runs within the run's bounds (`ctx.bounds`, from the stack's `limits.run` and what a calling agent sent):
its deadline (none: no deadline beyond the system's own `limits.system.timeoutMs`), its `hops` and `maxHops`, so the
system's member calls count on from the hops of the run and stop with `hop_limit` at its limit, and as budget what the
run reserves for the system with `outboundBounds` (everything not yet spent; no local refusal, the system applies the
hop limit and the deadline itself). The reservation is settled with the `usage` and `costUsd` the system reports; a run
with no budget left ends `stopped` with `limit` before the system runs. The lineage (`rootRunId`, `parentRunId`) of a
delegated run is the system run's lineage.

| `SystemResult` | `RunResult` |
|---|---|
| `status`, `output`, `usage`, `costUsd` | the same; `runId` is the agent-layers run id |
| `reason.code`, `reason.by` | the same, `hop_limit` included |
| `reason.layer` | `reason.memberLayer` when agent-layers has that layer (a stack member's stop), else `reason.layer` when agent-layers has it, else `harness` (topology, member, host, …) |
| `reason.stage` | `send` becomes `tool_args`, `receive` becomes `tool_result` |
| `reason.detail` | dropped: it is internal and may carry error text |
| `record` | `ext["agent-plexus.hops"]`, the number of hop records; no texts |

A system that cannot be assembled is a `failed` run with `{ code: "error", layer: "harness", by: "agent-plexus",
detail: "<error name>" }`. Systems are closed with the stack.

## Not mapped yet

| What | Why |
|---|---|
| Stack `policy` rules | Only the authorization adapter is asked; the local rules of the config are applied by agent-layers' own tool pipeline |
| `resume` and `cancel` of the member with agent-layers before 0.4.0 | A `waiting` stack run is reported as `waiting`, its approval under `ext["agent-layers.approval"]`; the plexus wait is a member wait (kind `input`), which such a stack cannot continue |
| An approval answer through `System.resume` to a member wait | The plexus reply to a member wait is input; the approval is decided through the stack, then the input continues the run |
| Stack tools as the tool source of a `supervise` topology | Planned; the `supervise` kind exists (basic-topology), its supervisor is a member |

## Limits

- An approval is keyed by caller, member, agent and system run: it lets one call of one run through. A retry of a
  `waiting` run must reuse the run id (`ctx.runId` of `System.run`); a new run asks again. Without `lookup` on the
  approval adapter every call asks again, and an answer given through `System.resume` cannot name the approval.
- A system run started with `System.run` and no run id gets a generated one; the host receives that id.
- The bounds a stack member receives are asserted by the system in the same process; a stack member reached over a
  network is bounded by what `a2a-member` sends (see the [bounds extension](../../../../spec/extensions/bounds-v1.md)).
