# @agent-plexus/adapter-agent-layers

Maps **an agent-layers stack** → **Host** and **MemberPort**, and **an agent-plexus system** → the **RuntimePort** of an
agent-layers stack. Tier: prototype, production. Maturity: experimental.

The only package that depends on agent-layers (`@agent-layers/core`, from npm). It has three parts:

| Part | Fills | Entry point |
|---|---|---|
| Host `agent-layers` | agent-plexus `Host` | `@agent-plexus/adapter-agent-layers` |
| Member `agent-layers` | agent-plexus `MemberPort` | `@agent-plexus/adapter-agent-layers` |
| Runtime `agent-plexus` | agent-layers `RuntimePort` (layer `harness`) | `@agent-plexus/adapter-agent-layers/runtime` |

The two entry points are separate modules, so each loader sees only its own descriptors: agent-plexus reads `adapters`
of the main entry, an agent-layers config loads the runtime as a plugin.

## Host

Composes the stack of an agent-layers config once (`loadConfig` and `compose`) and builds the four hooks from it. The
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
| `gate.allow`, approval | ApprovalPort | For a member in `approve` that was allowed: a decision already taken for the same caller, member, agent and system run is used first (approved allows once, denied denies); otherwise an approval is requested and the call is `ask` (the run is `waiting`, `needs_input`) until a person decides. No approval adapter: deny |
| `gate.token` | CredentialPort | `credentials.token(audience, { caller })` with the plexus caller mapped to the agent-layers caller, credential included. No credential adapter: no token |
| `gate.check` | every GuardPort | The guard context carries the run id and session of the call. `send` runs the guards of stage `tool_args`, `receive` those of `tool_result`, in order, through the stack's own guard runner (spans and metrics included). The first block is a block; a redaction carries its text on; a failing guard is a block that does not echo the error |
| `telemetry` | TelemetryPort fan-out | Spans, events and metrics keep their `plexus.*` names and attributes and gain `agent.layer: "harness"` |
| `score` | EvaluatorPort adapters | Present when the stack has evaluators. The case becomes an agent-layers case (`expected` is the expected output text: `equals`, else `contains`, else `matches`; the whole expectation is under `ext["agent-plexus.expected"]`), the result an `EvalRun`; scores come back as `{ metric, value, reason }` |
| `state` | none | Not provided |

`state` is omitted: agent-layers' StatePort is an append-only event log per session (`append`, `read`, `list`,
`delete`), not a key/value store. Mapping `get`/`set`/`delete` onto it would need a delete-then-append that is not
atomic, and would mix host keys with the run events the runtime stores under session ids.

Closing the system closes the stack.

## Member

Offers an agent of a composed stack as a member. One stack per member instance.

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
pinned: true }`. `invoke` runs `stack.agent(<agent>).run(text, …)` with the plexus caller (no credential), the session,
the abort signal and the trace context; when the pipeline gave the member a credential for its audience, it becomes the
caller's credential. The run result maps one to one:

| agent-layers `RunResult` | `MemberResult` |
|---|---|
| `status`, `output`, `runId`, `usage`, `costUsd` | the same |
| `reason.code`, `reason.by`, `reason.detail` | the same |
| `reason.layer` (an agent-layers layer id) | `reason.layer` |
| `reason.stage`, `events`, `ext` | not carried |

## Runtime

An agent-layers `RuntimePort` named `agent-plexus` (layer `harness`) that runs a system instead of a tool loop. Load it
as a plugin and name it in the `runtime` slot:

```json
{
  "plugins": ["@agent-plexus/adapter-agent-layers/runtime"],
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
only to mint member tokens), session, abort signal and trace context, and returns:

| `SystemResult` | `RunResult` |
|---|---|
| `status`, `output`, `usage`, `costUsd` | the same; `runId` is the agent-layers run id |
| `reason.code`, `reason.by` | the same |
| `reason.layer` | the same when agent-layers has that layer, else `harness` (topology, member, host, …) |
| `reason.stage` | `send` becomes `tool_args`, `receive` becomes `tool_result` |
| `reason.detail` | dropped: it is internal and may carry error text |
| `record` | `ext["agent-plexus.hops"]`, the number of hop records; no texts |

A system that cannot be assembled is a `failed` run with `{ code: "error", layer: "harness", by: "agent-plexus",
detail: "<error name>" }`. Systems are closed with the stack.

## Not mapped yet

| What | Why |
|---|---|
| Bounds (deadline, hops, budget) and lineage | agent-layers has no bounds yet (see the [proposal](../../docs/proposals/agent-layers-delegation-bounds.md)). `ctx.outbound` is not passed on; a stack member is bounded only by the abort signal |
| Actors | Until the same proposal lands, agent-layers' caller has no `actors`. The plexus `actors` travel as `ext["agent-plexus.actors"]` and are not read back |
| Host `state` | See above |
| Stack `policy` rules | Only the authorization adapter is asked; the local rules of the config are applied by agent-layers' own tool pipeline |
| `resume` and `cancel` of the member | A `waiting` stack run is reported as `waiting`; its approval id is in `reason.detail` |
| Stack tools as the tool source of a `supervise` topology | Planned; the `supervise` kind is not implemented yet |

## Limits

- An approval is keyed by caller, member, agent and system run: it lets one call of one run through. A retry of a
  `waiting` run must reuse the run id (`ctx.runId` of `System.run`); a new run asks again. Without `lookup` on the
  approval adapter every call asks again.
- A system run started with `System.run` and no run id gets a generated one; the host receives that id.
- Nothing bounds a stack member's time except the abort signal and the pipeline's step timeout.
