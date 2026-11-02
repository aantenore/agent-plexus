# Guide

How to start a system, write a member, write an adapter, add a host, configure a system, and move it from prototype to
production. Concepts are in [architecture.md](architecture.md). Packages are at version 0.2.0; the examples below work
inside this repository.

## Quickstart: start a system from the offline example

`examples/offline` is a support system of three function members. It uses only the reference adapters and the
prototype host, so it runs with no network, no model and no agent runtime.

```bash
npm install
node --conditions=@agent-plexus/source packages/cli/src/cli.ts check --config examples/offline/plexus.json
node --conditions=@agent-plexus/source packages/cli/src/cli.ts run --config examples/offline/plexus.json "I need a refund for my last invoice"
node --conditions=@agent-plexus/source packages/cli/src/cli.ts eval --config examples/offline/plexus.json examples/offline/cases.json
```

To start your own system, copy `examples/offline` to a new folder in the repository, edit `plexus.json` and the
modules in `members/`, and point `--config` at it. Rename the package in the copy's `package.json`: the example is the
workspace `@agent-plexus/example-offline`, and two workspaces with one name make `npm install` fail. Or copy it outside
`examples/` (still inside the repository, so Node finds `node_modules`) and leave `package.json` and `tsconfig.json`
behind. Adapters named in the config are found in the `plugins` modules first, then as
`@agent-plexus/adapter-<name>` from the repository's `node_modules`; module paths in options are relative to the
config file. The `--conditions=@agent-plexus/source` flag makes Node load the TypeScript sources of the workspace
packages; the sections below write the command as `agent-plexus`.

| Piece of `plexus.json` | In the example |
|---|---|
| `members` | `triage`, `billing`, `manuals`, each a `function-member` with a `module` and a `description` |
| `ports.registry` | `static-registry`, tagging `billing` and `manuals` |
| `ports.router` | `skill-router` with two regular-expression rules |
| `ports.topology`, `execution`, `attribution` | `basic-topology`, `memory-execution`, `rule-attribution` |
| `topology` | `sequence [triage, route{candidates: [billing, manuals], fallback: triage}]` |
| `limits.system.maxSteps` | `10` |
| `profiles` | `prototype` (`host: null`) and `production` (`tier: "production"`, which `check` refuses) |

`examples/swap` is the same system with each layer replaced by one config value: one `swap-*` profile per layer, and
`swap-all` with the swaps together. Each swap is a single value in `plexus.json`, and the system keeps its routes and
the attribution of the crash case. The profiles table is in its [README](../examples/swap/README.md);
`npm run swap:matrix` runs every swap, tests and command line. Evaluating one:

```bash
node --conditions=@agent-plexus/source packages/cli/src/cli.ts eval --config examples/swap/plexus.json --profile swap-all examples/swap/cases.json
```

Two cases pass; the crash case fails and is attributed to member `billing`, so the exit code is 1.

## Concepts in one paragraph each

- **Layer**: one of six concerns, with a stable id (`routing`). Each answers one question.
- **Port**: the interface for a layer's job (`AgentRouterPort.route → RouteDecision`), versioned per port.
- **Adapter**: maps a framework, a protocol or a technology onto a port. A descriptor declares what it fills, what it
  maps, the port version, tiers, an options schema and limits.
- **Member**: one configured agent, an instance of MemberPort under a member id.
- **Topology**: data (`TopologySpec`) that says how members are called; a topology adapter runs it.
- **Host**: the object that brings `gate`, `telemetry`, `score` and `state`. The prototype host is the default.
- **memberCall**: the core pipeline every member call goes through.
- **System**: what `assemble(config)` returns: `run`, `entries`, `attribute`, `score`, `check`, `close`.
- **Hop record**: one entry per member call, with member, node path, status, reason, usage and journal keys.

## Write a member

A function member is a module that exports a function. It receives the input and the call context and returns text,
or a full `MemberResult` to report another status.

```ts
import { inputText, type MemberCallContext, type MemberResult, type RunInput } from '@agent-plexus/core';

export function answer(input: RunInput, ctx: MemberCallContext): string | MemberResult {
  const text = inputText(input).toLowerCase();
  if (text.includes('crash')) return { status: 'stopped', output: '', reason: { code: 'error' } };
  return `Billing: handled ${ctx.hopId}`;
}
```

```json
{
  "members": {
    "billing": {
      "adapter": "function-member",
      "options": { "module": "./members/billing.ts#answer", "description": "Answers invoice questions", "tags": ["billing"] }
    }
  }
}
```

Rules:

- A non-`completed` result needs a `reason`; without one the adapter adds `{ code: "error" }`.
- Branch on `reason.code` only; `detail` is internal text.
- Honour `ctx.signal`. The adapter returns `stopped` / `aborted` when it fires, but it cannot interrupt the function.
- Never put a credential in an output. `ctx.credential` is the token for the member's audience, from the host.

## Call a remote agent

An agent served over A2A, in any language or framework, is a member through `a2a-member`. The member id is a key under
`members`; the topology names it like any other member.

```json
{
  "members": {
    "billing": {
      "adapter": "a2a-member",
      "options": {
        "url": "https://agents.example.com/billing/.well-known/agent-card.json",
        "audience": "https://agents.example.com",
        "keys": "https://agents.example.com/.well-known/jwks.json",
        "requireSigned": true,
        "timeoutMs": 120000
      }
    }
  },
  "topology": { "kind": "sequence", "steps": ["billing"] }
}
```

- The card is fetched without a credential and checked against `keys`; with `requireSigned` an unsigned card is
  refused. The endpoint of the card is used only when it has the origin of `url` or is in `allowedEndpoints`.
- The credential is not an option: the host's gate mints a token for `audience`, and the member sends it to the checked
  endpoint only. Without `audience` the agent is called without a credential.
- https is required except on loopback; private addresses are refused unless that origin is configured; redirects are
  never followed. The rules are listed in [security](cross-cutting/security.md#remote-agents-over-a2a).
- A call returns once the remote side has a task. The task id is journaled, the task is polled every `pollMs`, and a
  restart of the same run resumes that task instead of sending the request again. On a deadline the member cancels
  the remote task; on an abort the core does, through the member's `cancel`, so the task is cancelled once.
- The remaining time, hops, budget and lineage go along in the [bounds extension](../spec/extensions/bounds-v1.md),
  under the canonical agent-layers URI (`boundsUri: "plexus"` sends the older alias); the remote report settles the
  budget, and a remote refusal over the hop limit is `stopped` with `hop_limit`.
  A remote task that waits for input ends the call as `waiting` with code `needs_input` (or `needs_auth`); answer it
  with [resume](#resume-a-waiting-run).
- Limits (`timeoutMs`, `pollMs`, `maxCardBytes`, `cardTtlMs`, `cancelTimeoutMs`) are in [limits](limits.md#a2a-member--memberport).

All options, the state mapping and what is not done are in the
[adapter README](../adapters/a2a-member/README.md).

## Resume a waiting run

A run ends `waiting` when the host's gate answers `ask` (a person must approve the call) or a member asks for more
input. `resume` answers it under the same run id: finished steps replay from the journal and the waiting call gets the
reply. Across processes the journal must outlive the process, so the system needs a durable execution adapter, such as
[`sqlite-execution`](../adapters/sqlite-execution); `memory-execution` resumes only within the process that ran the run.
The swap example's [`file-execution`](../examples/swap/adapters/file-execution.ts) keeps it in JSON files:

```json
{
  "ports": {
    "execution": { "adapter": "./adapters/file-execution.ts", "options": { "dir": "./journal" } }
  }
}
```

```text
$ agent-plexus run "change the delivery address"
[waiting] needs_input member
waiting: agent-plexus resume 3f0c... --input <text> --wait 'call:root.steps[0]:0#0'
$ agent-plexus resume 3f0c... --input "order 42, new address: 1 Main St" --wait 'call:root.steps[0]:0#0'
Shipping: the address of order 42 is changed
```

`run` and `resume` exit `3` when the run ends waiting, so a script can tell a pending run from a failed one (`1`).
The hint names the reply the run's wait needs and the wait itself. `--wait <token>` is optional but recommended: a
reply that names its wait answers only that one, so a repeated or late resume fails ("waits on another step") instead
of answering a wait the run reached since.

| Waits on (`wait.kind`) | Reply | What happens |
|---|---|---|
| The host's gate (`approval`: `needs_input`, layer `host`) | `--approve` or `--deny`, optional `--reason <text>` | `gate.allow` is asked again with `answer: { approved, reason?, by? }` (`by`: who resumes); the host decides |
| A member (`input`: `needs_input` or `needs_auth`, layer `member`) | `--input <text>` | The text passes the send check, then the member's `resume(taskRef, input)` continues its task |

In code: `system.resume(runId, { input, wait: result.wait.token })` or `system.resume(runId, { approved: true, wait:
result.wait.token })` (`wait` optional), with an optional context whose `caller` is who resumes. A waiting result's
`wait` (`{ token, kind, member }`) says which call the run waits on and which reply it takes. The host's gate is asked
first whether that caller may resume the run (action `resume`, with the run's owner); the prototype host allows only
the caller that started it. The resume is a new invocation with its own deadline; its budget is the run's, less what
earlier invocations spent (`run:spent`), and its result counts only what it spent. A run that is not waiting, a reply of the other kind or for another wait, or a `run` or `resume`
while another invocation runs the same run ("in progress") gives `failed` with code `error`. Details:
[execution](layers/execution.md#waiting-and-resume).

## Write an adapter

An adapter is a package `@agent-plexus/adapter-<name>` with a factory and a descriptor. A router that picks the
candidate whose skill tags occur most often in the input:

```ts
import { defineAdapter, defineLimits, inputText, PORT_VERSIONS, type AgentRouterPort } from '@agent-plexus/core';

export interface TagRouterOptions {
  fallbackFirst?: boolean;
  maxInputChars?: number;
}

const DEFAULT_MAX_INPUT_CHARS = 10_000;

export const limits = defineLimits({
  maxInputChars: {
    path: 'options.maxInputChars',
    default: DEFAULT_MAX_INPUT_CHARS,
    unit: 'count',
    min: 1,
    integer: true,
    why: 'Input characters the router reads.',
  },
});

export function createTagRouter(options: TagRouterOptions, name = 'tag-router'): AgentRouterPort {
  const max = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  return {
    name,
    async route({ input, candidates }) {
      const text = inputText(input).slice(0, max).toLowerCase();
      const ranked = candidates
        .map((c) => ({ member: c.id, score: c.skills.flatMap((s) => s.tags).filter((t) => text.includes(t.toLowerCase())).length }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (best) return { member: best.member, ranked };
      return options.fallbackFirst && candidates[0] ? { member: candidates[0].id } : {};
    },
  };
}

export const adapter = defineAdapter<'AgentRouterPort', TagRouterOptions>({
  fills: 'AgentRouterPort',
  name: 'tag-router',
  maps: { technology: 'tag match on the input text' },
  portVersion: PORT_VERSIONS.AgentRouterPort,
  tiers: ['prototype', 'production'],
  optionsSchema: {
    type: 'object',
    properties: { fallbackFirst: { type: 'boolean' }, maxInputChars: { type: 'integer', minimum: limits.maxInputChars.min } },
    additionalProperties: false,
  },
  limits,
  create: (options, ctx) => createTagRouter(options, ctx.name),
});

export const adapters = [adapter];
```

And its test, with `node:test`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noopTelemetry, type AgentEntry } from '@agent-plexus/core';
import { adapter } from '../src/index.ts';

const entry = (id: string, tags: string[]): AgentEntry => ({
  id, name: id, description: '', skills: [{ id: 'main', name: id, description: '', tags }],
  endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true },
});

test('tag-router fills AgentRouterPort and picks by tag', async () => {
  assert.equal(adapter.fills, 'AgentRouterPort');
  const router = await adapter.create({}, { name: 'router', cwd: '.', env: {}, telemetry: noopTelemetry });
  const run = { runId: 'r1', system: 's' };
  const candidates = [entry('billing', ['invoice', 'refund']), entry('manuals', ['setup'])];
  assert.equal((await router.route({ input: 'I need a refund', candidates }, run)).member, 'billing');
  assert.equal((await router.route({ input: 'hello', candidates }, run)).member, undefined);
});
```

Steps:

1. Create `adapters/<name>/` and copy `package.json`, `tsconfig.json` and `tsconfig.build.json` from a reference adapter
   such as `adapters/skill-router`. Name the package `@agent-plexus/adapter-<name>`; keep `@agent-plexus/core` as a peer
   dependency and the `@agent-plexus/source` export condition that points at `src/`.
2. Write `src/index.ts`: a factory and a `defineAdapter` descriptor with `fills`, `name` (= `<name>`), `maps` (`standard`
   or `technology`), `portVersion: PORT_VERSIONS.<Port>`, `tiers` and `optionsSchema`. Export an `adapters` array: the
   loader reads it.
3. Declare every timeout, size, count or truncation length once with `defineLimits` and set it as the descriptor's
   `limits` (see [limits.md](limits.md)), never a literal in the code.
4. Write `test/*.test.ts` with `node:test`, including the port's contract tests from the conformance kit
   `@agent-plexus/conformance`.
5. Write `README.md`: what it maps onto which port, tiers, an options table and a config snippet.
6. Add the adapter to [adapters.md](adapters.md), and its limits to [limits.md](limits.md).
7. Use it by name (`"adapter": "tag-router"`) once the package is installed, or by path while you develop:
   `"adapter": "./tag-router/src/index.ts"`; `#<name>` picks one descriptor when a module exports several for the port.
   A package outside `@agent-plexus/adapter-*` (`@acme/plexus-adapters`) is listed in the config's `plugins`; its
   adapters are then named like any other (see [Adapter lookup](#adapter-lookup)).

Checks for the pull request, run only for the package you touched:

```bash
npm run typecheck -w @agent-plexus/adapter-<name>
npm test -w @agent-plexus/adapter-<name>
```

Rules:

- Name the package after the framework, protocol or technology it maps. If it speaks a standard, set `maps.standard`;
  otherwise `maps.technology`.
- Translate at the edge. A protocol's names stay inside the adapter; what crosses the port is the language
  ([spec/language.md](../spec/language.md)).
- Errors a topology should see are results (`status`, `reason.code`), not exceptions; the core maps a throw to
  `failed` / `error`.
- Never put tokens or secrets in errors, logs or telemetry attributes.
- Put technology-specific data in `ext` (keys `<adapter>.<name>`).
- `tiers: ['prototype']` for in-memory or development-only adapters; add `production` when a real system backs it.
- `portVersion` is `0.1.0` for every port. The core refuses an adapter whose `portVersion` is not compatible with its
  own (`PORT_VERSIONS`): same major and, while the major is `0`, same minor. The message names the adapter, its version
  and the core's.
- The core checks every descriptor it loads with `checkDescriptor`: `fills` a known port or `Host`, a non-empty
  `name`, `maps` with a `standard` or a `technology`, `tiers` a non-empty subset of `prototype` and `production`, an
  object `optionsSchema`, a semver `portVersion` (required for ports), `create` a function.
- A MemberPort adapter declares what it can do beyond `describe` and `invoke` in `capabilities`: `resume`, `cancel`,
  `checkpoint`, `waits` (booleans, absent = `false`). The readiness gate warns when a member `waits` without `resume`,
  and when a member that `checkpoint`s without `cancel` races under a `parallel` with `join: "first"`.

### Adapter lookup

An `adapter` value is resolved in this order:

| Value | Found in |
|---|---|
| Starts with `.` or `/` | The module at that path, relative to the config file; `#<name>` picks one descriptor |
| A name exported by a `plugins` module | That module; the first plugin listed wins |
| Any other name | The package `@agent-plexus/adapter-<name>` |

`plugins` lists modules, packages or paths, resolved as an `import` written in the config's directory would be: a path
relative to it, or a package installed in a `node_modules` above it, through its `exports` with the import conditions
(`node`, `import`, the `--conditions` of the process, `default`), so an ESM-only package works and a dual package loads
its ESM entry. A package that is not installed there is an error; it is never looked up elsewhere. A plugin exports
descriptors in `adapters`, `default` (a CommonJS `module.exports` object is searched too) or any named export, alone or
in an array:

```json
{
  "plugins": ["@acme/plexus-adapters", "./adapters/local.ts"],
  "members": { "billing": { "adapter": "acme-crm-member" } }
}
```

A plugin that fails to resolve or import, or that exports no descriptors, fails the adapter that looked it up, naming
the plugin. In code, `assemble` uses
`pluginLoader(config.plugins)`; `resolveAdapter` replaces it in tests.

## Add a host

A host brings `gate`, `telemetry`, `score` and `state`. Pass one in code, or configure a host adapter that fills
`Host`. A host that allows only listed members:

```ts
import { defineAdapter, type Host } from '@agent-plexus/core';

interface Options {
  allowed: string[];
}

export const adapter = defineAdapter<'Host', Options>({
  fills: 'Host',
  name: 'allow-list-host',
  maps: { technology: 'static allow list' },
  tiers: ['prototype'],
  optionsSchema: {
    type: 'object',
    properties: { allowed: { type: 'array', items: { type: 'string' } } },
    required: ['allowed'],
    additionalProperties: false,
  },
  create: (options, ctx): Host => ({
    name: ctx.name,
    tier: 'prototype',
    gate: {
      allow: async ({ member }) => (options.allowed.includes(member.id) ? { effect: 'allow' } : { effect: 'deny', reason: 'not on the list' }),
      token: async () => undefined,
      check: async () => ({ action: 'allow' }),
    },
    telemetry: {
      span: (name, attrs, fn) => fn({ set: () => {}, event: () => {} }),
      event: () => {},
      metric: () => {},
    },
  }),
});

export const adapters = [adapter];
```

```json
{ "host": { "adapter": "./host.ts", "options": { "allowed": ["triage", "manuals"] } } }
```

With that host the offline example runs `triage`, then the router chooses `billing` and the gate denies it: the run
stops with `[stopped] denied host`, the hop line reads `billing stopped denied`, and the exit code is 1. In code, skip
the config entry:

```ts
const system = await assemble(await loadConfig('plexus.json'), { host });
```

Rules:

- `allow` and `check` are called for every member call; an error from either is a deny or a block.
- `token(caller, audience)` returns a credential for the member's audience, on behalf of the caller. Never return the
  caller's own credential.
- Set `tier: 'production'` only for a host backed by real identity, policy and observability; the readiness gate reads it.
- The reference for the hooks is [spec/hooks.md](../spec/hooks.md).

### A real host: agent-layers

[`@agent-plexus/adapter-agent-layers`](../adapters/agent-layers) builds the four hooks from an agent-layers stack, so
the control and insight you already configured there govern the system. Install it next to the config of a stack and
point the host at that config:

```json
{
  "host": {
    "adapter": "agent-layers",
    "options": { "config": "../agent-layers/agent-layers.json", "profile": "production", "risk": { "billing": "write" }, "approve": ["billing"] }
  }
}
```

| Hook | Comes from the stack's |
|---|---|
| `gate.allow` | AuthorizationPort: each member call is the question `{ caller, action: "call", target: { kind: "agent", id: <member>, layer: "harness", risk } }`; members in `approve` also go through the ApprovalPort and the run is `waiting` until a person decides, through the stack or through `System.resume` (the answer is recorded with `decide`, `by` the resuming owner) |
| `gate.token` | CredentialPort, for the member's `audience` |
| `gate.check` | GuardPorts: `send` runs the `tool_args` guards, `receive` the `tool_result` guards |
| `telemetry` | TelemetryPort; every `plexus.*` record gains `agent.layer: "harness"` |
| `score` | EvaluatorPorts |
| `state` | StorePort, when the stack configures one: keys `plexus.<key>`; none otherwise |

An authorization rule that allows the members and denies the rest is then written in the stack, where the rules for its
tools already live:

```json
{ "layers": { "authorization": { "adapter": "rules-authorization", "options": { "rules": [
  { "effect": "allow", "tools": ["triage", "billing"] }, { "effect": "deny", "tools": ["admin"] }
], "default": "deny" } } } }
```

The host is `production`-tier when the stack's profile is, and a production tier without an authorization adapter
denies every call.

The same package has two more descriptors. The member `agent-layers` (`"adapter": "agent-layers"` under `members`) is an
agent of a stack, in process; the call's deadline, hops, budget and lineage become the stack run's `delegation`, and the
caller's `actors` its actors. The runtime plugin `agent-plexus`, loaded through the `plugins` of the agent-layers config
(`"plugins": ["@agent-plexus/adapter-agent-layers/runtime"]`), runs a system as the runtime of a stack, so the
agent-layers gateway can serve it; the system runs within the stack run's bounds. The stack's tools as the tool source of `supervise` are planned. The options,
mappings and limits are in the [adapter README](../adapters/agent-layers/README.md).

## Stack config reference

`plexus.json`, loaded by `agent-plexus` with `--config <file>` (default `plexus.json` in the working directory). A JSON
Schema file is planned.

| Key | Meaning |
|---|---|
| `system.name` | System name; the `plexus.system` attribute |
| `plugins` | Modules (packages or paths) exporting adapter descriptors, for adapters outside `@agent-plexus/adapter-*`; see [Adapter lookup](#adapter-lookup) |
| `host` | `{ adapter, options? }` filling `Host`; absent or `null`: the prototype host |
| `members` | Member id → `{ adapter, options? }` filling MemberPort |
| `ports.registry` | Required by a `route` or `handoff` node, which reads its candidates from it (`check` fails without one) |
| `ports.router` | One `{ adapter, options? }` (the router `router`), or a map of names to refs; `route` and `handoff` nodes name one with `router` |
| `ports.topology`, `ports.execution`, `ports.attribution` | Required; `{ adapter, options? }` |
| `topology` | A `TopologySpec`: a member id or a node; see [spec/language.md](../spec/language.md#topologyspec) |
| `limits` | `system`, `router`, `attribution` groups; every limit is in [limits.md](limits.md). Card size and lifetime are options of the adapter that fetches cards (`a2a-member`), not core limits |
| `registry.requireSigned` | `true`: every member needs a signed card or a pinned endpoint |
| `registry.requireListed` | `true`: every member call needs `ports.registry` to return the member, also for a member the topology names; one it does not return is `denied`, layer `registry`. Without it a registry only supplies route candidates |
| `tier` | `prototype` (default) or `production` |
| `profiles.<name>` | An overlay of any other key, applied with `--profile`; objects merge, arrays replace, `null` removes |
| `$schema` | Accepted and ignored |

Strings in adapter options may use `${env:NAME}` and `${env:NAME:-default}`. A limit may be a whole-string reference
to a number; the value is range-checked after interpolation. Unknown keys are rejected, with their paths.

## From prototype to production

The promise: the members, the topology and the tests never change; only the host and the adapters do.

**The ladder.** Profiles overlay the base config. The offline example has two:

```json
"profiles": {
  "prototype":  { "host": null },
  "production": { "tier": "production" }
}
```

**The readiness gate.** `check --profile production` fails when the host is a prototype, when an adapter is
prototype-only, when a limit is `"unbounded"` where that is unsafe, and when `registry.requireSigned` finds an unpinned
member. It warns for limits outside their safe range ([limits.md](limits.md)). On every tier it fails a `route` or
`handoff` node without `ports.registry`, and warns when a member's declared `capabilities` fall short (`waits` without
`resume`; `checkpoint` without `cancel` under a `parallel` with `join: "first"`) and when the execution adapter has no
`read` (attribution cannot trace stored texts, and expectations on member outputs cannot be scored). On the offline example:

```text
$ agent-plexus check --config examples/offline/plexus.json --profile production
system support · profile production · tier production
FAIL $.host: host "prototype" is a prototype host; a production tier needs a real host
FAIL $.ports.execution: adapter "memory-execution" is prototype-only and cannot be used on the production tier
check failed: 2 FAIL, 0 WARN
```

**What moves, one at a time.**

| Finding | Fix | Status |
|---|---|---|
| `$.host` | A host adapter backed by real identity, policy and telemetry; the agent-layers adapter | Available: [`agent-layers`](#a-real-host-agent-layers) |
| `$.ports.execution` | A durable ExecutionPort: `sqlite-execution`; `host-execution` (planned); DBOS, Temporal, Hatchet (candidates) | Available: [`sqlite-execution`](../adapters/sqlite-execution) |
| `$.members.<id>` | Members behind `a2a-member` with signed cards (`keys`, `requireSigned`) or pinned endpoints | Available: [`a2a-member`](#call-a-remote-agent) |
| limits | Set `limits.system.*` explicitly and keep them in the safe range | Implemented |

The production profile of the offline example fails by design: it uses `memory-execution`, which is prototype only.
Swap in `sqlite-execution` to pass that finding.

## Eval and attribution

`eval` runs a file of cases through the system, scores each one with the host's `score` hook (the built-in `expected`
checks when the host has none) and attributes every failure from its hop record.

```json
[
  {
    "id": "billing-refund",
    "input": "I need a refund for my last invoice",
    "expected": {
      "output": { "contains": "refunds are issued" },
      "members": { "billing": { "status": "completed" } }
    }
  }
]
```

| Field | Meaning |
|---|---|
| `id`, `input` | Required. `input` is text, or `{ text }` |
| `expected.output` | `equals`, `contains`, `matches` (regular expression) on the system output |
| `expected.members.<id>` | `status`, `contains`, `matches` on the last hop of that member; a missing hop fails |
| `tags` | Free labels |

A case passes when the run completed and every score is 1. The prototype host scores `expected.output` and
`expected.member`, as the core does for a host without `score`; a production host may add more. On a failed case `eval` prints the run status, the scores below 1
and one attribution line: `<layer> <member?> <memberLayer?> <confidence> <evidence>`.

```text
FAIL billing-crash
  run stopped error
  score expected.output 0 failed: contains
  score expected.member billing 0 failed: status
  attribution member billing 0.60 code:error,hop:<hopId>,node:root.steps[1]
eval: 2 passed, 1 failed
```

The attribution rules are in [layers/attribution.md](layers/attribution.md).

## CLI

| Command | What it does |
|---|---|
| `check` | Load the config, assemble the system, apply the readiness gate of the profile's tier; print `FAIL` and `WARN` lines and a summary |
| `run <text>` | One run: the output on stdout, one line per hop on stderr (`<member> <status> <code?> <ms>ms`); `--json` prints the result with the hop record, `--quiet` drops the hop lines, `--run-id <id>` runs under a chosen id (1 to 128 characters) instead of a generated one; a waiting run ends with the `resume` command that answers it |
| `resume <runId>` | Answer a waiting run and run it again: `--input <text>`, or `--approve` / `--deny` with `--reason <text>`, and `--wait <token>` to answer only that wait; output as `run`. Needs a durable execution adapter across processes; see [Resume a waiting run](#resume-a-waiting-run) |
| `dev` | Terminal loop: each line of input is one run; `/exit` or end of input quits; `--quiet` |
| `eval <cases.json>` | Run, score and attribute a file of cases; `--json` prints counts and, per case, status, output, scores and attributions |

Common options: `--config <file>` (default `plexus.json`), `--profile <name>`, `--help` (also per command).

| Exit code | Meaning |
|---|---|
| `0` | ok: `check` passed, the run completed, every case passed |
| `1` | findings, a failed or stopped run, a failed case, or an invalid system |
| `2` | wrong command line |
| `3` | `run` or `resume` ended `waiting` for a reply; answer it with the printed `resume` command |

`diff` and `draw` are planned.

## Extension rules

1. A new technology is an adapter plus its tests, never a core change.
2. A core change starts with the spec: the port page and the version in `PORT_VERSIONS`.
3. Adapters depend on `@agent-plexus/core` as a peer.
4. Framework and protocol names appear in adapters only; the core speaks one language.
5. Extra data goes in namespaced `ext` keys, never in a new field.
