# Adapters

Every implementation is an adapter: a module that maps a framework, a protocol or a technology onto a port. The
reference adapters ship in one package, `@agent-plexus/adapters`, one subpath export each
(`@agent-plexus/adapters/<name>`); an adapter maintained elsewhere is its own package, with its own maintainer and
release cadence.
How to write one: [guide.md](guide.md#write-an-adapter) and [CONTRIBUTING.md](../CONTRIBUTING.md).

A config names an adapter by name (`"adapter": "skill-router"`, found as `@agent-plexus/adapters/skill-router`), by
module path (`"./adapters/mine.ts#name"`), or by a name a `plugins` module exports: a package outside
`@agent-plexus/adapters` (`"plugins": ["@acme/plexus-adapters"]`) needs no rename. Lookup order and rules:
[guide.md](guide.md#adapter-lookup). The core checks each descriptor it loads (`checkDescriptor`) and refuses one
whose `portVersion` is incompatible with the core's. A MemberPort adapter declares its `capabilities` (`resume`,
`cancel`, `checkpoint`, `waits`), which the readiness gate reads. The conformance kit `@agent-plexus/conformance` runs
the port contract tests against an adapter.

## Maturity

| Level | Criteria |
|---|---|
| experimental | Descriptor and tests pass. Behaviour may change. |
| beta | Port conformance suite (`@agent-plexus/conformance`) passing in CI, a pinned upstream version with a live contract test where there is an upstream, an owner. |
| stable | Beta for at least one minor release of its port without breaking changes, documented options, used in a reference setup. |

## Catalog

Tiers: **prototype** adapters are for laptops, tests and demos; **production** adapters can run in production. The
readiness gate (`agent-plexus check --profile <p>`) rejects prototype-only adapters on production-tier profiles. Every
adapter below is at maturity **experimental**; ports are at version 0.1.0.

Status words: **implemented** is in this repository with its tests. **Planned** is work on the order of work: the
adapters in the Planned table below, the JSON Schemas and the CLI commands `diff` and `draw`. A **candidate** is a technology worth an adapter, with no work scheduled.

### Available

Each adapter has its own README under `packages/adapters/src/<name>/`, with options, behaviour and limits.

#### Member plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `member` | [`function-member`](../packages/adapters/src/function-member) | MemberPort | technology: in-process function | prototype, production | implemented | experimental |
| `member` | [`agent-layers`](../packages/adapters/src/agent-layers) | MemberPort | technology: agent-layers stack | prototype, production | implemented | experimental |
| `member` | [`a2a-member`](../packages/adapters/src/a2a-member) | MemberPort | standard: Agent2Agent (A2A) 1.0 and 0.3, JSON-RPC binding (official JavaScript SDK) | prototype, production | implemented | experimental |

Declared `capabilities`: `a2a-member` all four (`resume`, `cancel`, `checkpoint`, `waits`); `agent-layers` `waits`,
and `resume` and `cancel` when the installed agent-layers has run control (0.4.0 on; before, the readiness gate warns
that a run waiting on it cannot continue); `function-member` none.

#### Discovery plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `registry` | [`static-registry`](../packages/adapters/src/static-registry) | RegistryPort | technology: static member list. Optional `trust` policy (`requireSigned`, `keyIds`, `exempt`) withholds entries without a verified card signature and emits `plexus.registry.refused` | prototype, production | implemented | experimental |
| `routing` | [`skill-router`](../packages/adapters/src/skill-router) | AgentRouterPort | technology: rules on regular expressions, tags and skills | prototype, production | implemented | experimental |

#### Flow plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `topology` | [`basic-topology`](../packages/adapters/src/basic-topology) | TopologyPort | technology: in-process topology executor (`sequence`, `route`, `loop`, `parallel`, `handoff`, `supervise`, `graph`) | prototype, production | implemented | experimental |
| `execution` | [`memory-execution`](../packages/adapters/src/memory-execution) | ExecutionPort | technology: in-process memory | prototype | implemented | experimental |
| `execution` | [`sqlite-execution`](../packages/adapters/src/sqlite-execution) | ExecutionPort | technology: SQLite through `node:sqlite` | prototype, production | implemented | experimental |

#### Insight plane

| Layer | Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|---|
| `attribution` | [`rule-attribution`](../packages/adapters/src/rule-attribution) | AttributionPort | technology: deterministic rules on hop records | prototype, production | implemented | experimental |

#### Host

| Adapter | Fills | Maps | Tiers | Status | Maturity |
|---|---|---|---|---|---|
| [`agent-layers`](../packages/adapters/src/agent-layers) | Host | technology: agent-layers stack | prototype, production | implemented | experimental |
| [`agent-layers/runtime`](../packages/adapters/src/agent-layers) | an agent-layers RuntimePort (plugin of an agent-layers config) | technology: agent-plexus system | prototype, production | implemented | experimental |

The `agent-layers` adapter (`@agent-plexus/adapters/agent-layers`) is the only one that depends on agent-layers
(`@agent-layers/core`, an optional peer dependency of `@agent-plexus/adapters`: install it next to the package to use
this adapter). It has three descriptors:

- the host `agent-layers`: `gate` from the stack's authorization, approval, credentials and guards, `telemetry`,
  `score`, and `state` from the stack's StorePort when it has one (keys `plexus.<key>`);
- the member `agent-layers`: an agent of a stack, in process. The call's deadline, hops, budget and lineage become the
  stack run's `delegation`, and the caller's `actors` map both ways;
- the runtime plugin `agent-plexus`: an agent-layers RuntimePort that runs a system. An agent-layers config loads it
  through `plugins` (`@agent-plexus/adapters/agent-layers/runtime`), not agent-plexus, so it is a separate entry point.

Ten adapters in one package, `@agent-plexus/adapters`, under nine subpaths (`agent-layers` holds both the host and
the member), plus the runtime plugin under a tenth subpath, `agent-layers/runtime`.

### Planned

| Adapter | Fills | Layer | Maps | Status | Notes |
|---|---|---|---|---|---|
| `model-router` | AgentRouterPort | routing | technology: a model chooses among names and descriptions | planned | Any OpenAI-compatible endpoint, or a stack's governed model through `agent-layers` |
| `knowledge-router` | AgentRouterPort | routing | technology: a search backend ranks entries | planned | Any agent-layers knowledge source through `agent-layers` |
| `host-execution` | ExecutionPort | execution | technology: the host's `state` hook | planned | |
| `judge-attribution` | AttributionPort | attribution | technology: a model reads the hop record | planned | Agent level only |
| `replay-attribution` | AttributionPort | attribution | technology: offline counterfactual replay | planned | One member's output replaced, or one member swapped |
| `agent-layers`: tool source of `supervise` | — | member | technology: agent-layers stack | planned | The stack's tools as what a supervisor can call; the `supervise` kind exists, its supervisor is a member today |

### Candidates

No work is scheduled for these.

| Technology | Would fill | Layer |
|---|---|---|
| DBOS, Temporal, Hatchet | ExecutionPort (production) | execution |
| AGNTCY Agent Directory, Kubernetes CRDs | RegistryPort | registry |
| LangGraph.js, ADK-TS, Strands TS | TopologyPort | topology |
| Langfuse, Jaeger | record sources for attribution | attribution |

Sources and licenses: [research/landscape.md](research/landscape.md).

Frameworks that serve A2A (LangGraph, CrewAI, ADK, Microsoft Agent Framework, Strands, Pydantic AI) need no adapter of
their own: they join as members through `a2a-member`, which is tested against a real agent-layers stack served by its
gateway.
