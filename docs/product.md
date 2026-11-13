# Product

## Who it is for

Teams that run more than one agent and have to make them work as one system: application developers who want to wire
agents together on a laptop in minutes, and platform teams who have to run that system under the company's identity,
policy and observability.

## The problem

Every orchestration framework owns the loop, the state and the integrations of its agents, and choosing the framework
chooses them too. Agents built with different frameworks cannot join one system without glue, and the glue is where
production breaks:

- nothing carries a deadline, a budget or a hop limit from one agent to the next, so a chain of three agents can run
  three times the limit;
- a failure surfaces as the last agent's error, with no record of which agent or which layer caused it;
- the same control and insight code (identity, policy, content checks, tracing) is rebuilt next to every orchestrator.

## What agent-plexus promises

- **Independent.** The core depends on nothing and runs offline with reference implementations and prototype defaults
  for the hooks.
- **No second control plane.** Authorization, credentials, content checks, telemetry and scoring are host hooks.
  agent-plexus calls them and implements none. In production they must come from a real host.
- **Any agent is a member.** A function, an agent-layers stack in process, and an agent served over A2A (any
  framework or language) through `a2a-member`. Another agent-plexus system works in process through the `fn` option of
  `function-member` (a `SystemResult` extends `MemberResult`), and over the network when it is served over A2A.
- **One call path.** Every member call goes through `memberCall`; topologies cannot reach a member any other way.
- **Bounded.** System limits (steps, depth, parallelism, loops, handoffs, time) are enforced by the core. Deadline,
  budget and hops received from the host are honoured and passed on.
- **Failures land on an agent.** Each run keeps a hop record; attribution names a layer, a member and, when the member
  reports one, the member's own layer.
- **A system is an agent.** A result carries its hop record, so a system can be a member of another one. Exposure over
  the network is the host's: the agent-layers gateway serves a system through the runtime plugin of the `agent-layers`
  adapter.

## The developer journey

1. Write the members: plain functions, or any agent behind an adapter.
2. Write `plexus.json`: members, one adapter per port, a topology.
3. `agent-plexus check` — config, adapters, topology and readiness.
4. `agent-plexus run` and `dev` — one run, or a terminal loop, with one line per hop.
5. `agent-plexus eval` — score a file of cases and attribute each failure.
6. Move to production by editing a profile; `check --profile production` says what still has to change.

```mermaid
flowchart LR
  members["members<br/>functions, agents"]:::external --> config["plexus.json<br/>ports, topology"]:::external
  config --> check["check<br/>config, adapters,<br/>topology, readiness"]:::external
  check --> run["run, dev<br/>one line per hop"]:::external
  run --> eval["eval<br/>score, attribute<br/>to a layer and a member"]:::external
  eval --> prod["check --profile production<br/>real host, durable execution"]:::external
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Profile ladder

Profiles are overlays on the base config: objects merge, arrays replace, `null` removes a key. The readiness gate
applies when the profile's `tier` is `production`. Planned adapters and candidates are named but not installed yet.

```mermaid
flowchart TB
  subgraph proto["prototype: runs offline, prototype host"]
    base["All six layers<br/>function-member, static-registry, skill-router,<br/>basic-topology, memory-execution, rule-attribution"]:::external
  end
  subgraph prod["production: a real host"]
    xhost["host<br/>agent-layers stack"]:::control
    xmem["L0 member<br/>a2a-member"]:::foundation
    xreg["L1 registry<br/>signed cards or pinned endpoints"]:::model
    xexe["L4 execution<br/>sqlite-execution,<br/>host journal (planned),<br/>DBOS (candidate)"]:::agent
    xatt["L5 attribution<br/>rule-attribution, judge (planned)"]:::insight
  end
  proto -->|"edit the profile"| prod
  prod -->|"agent-plexus check --profile production"| gate["readiness gate"]:::external
  classDef foundation fill:#d9dde3,stroke:#57606a,color:#1f2328
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Non-goals

- Not an agent runtime: the loop of each agent belongs to the agent.
- Not a control plane: no identity, policy, guard, telemetry or evaluation implementation beyond prototype defaults.
- Not a server: network exposure is the host's.
- Not a protocol: A2A is the wire; the bounds extension is defined once, in the
  [agent-layers proposal](proposals/agent-layers-delegation-bounds.md), and reused.
- No visual builder, no hosted control plane.

## How it compares

| | Scope | Who owns the loop and the controls | Across frameworks |
|---|---|---|---|
| Orchestration frameworks (LangGraph, CrewAI, Microsoft Agent Framework, ADK, Strands, Mastra, ...) | Orchestrate agents of their own kind | The framework | Mostly through A2A, without a shared deadline, budget or hop limit |
| Durable execution engines (Temporal, DBOS, Hatchet) | Survive restarts | The engine | Not agent-aware |
| Agent stacks (agent-layers) | Everything one agent needs: identity, guardrails, telemetry, evaluation | The stack | One agent at a time |
| agent-plexus | The six layers between agents | The host (control and insight); each agent (its loop) | Any agent that can be called, with bounds and attribution |

agent-plexus can use all of these: a framework as a member over A2A, an engine behind ExecutionPort, a stack as the
host. What it adds is the composition between agents. The landscape is in [research/landscape.md](research/landscape.md).

### Named alternatives

As of November 2026. Each covers part of what agent-plexus does; none that we know of carries the deadline, budget and hop limit of a
run across members of different frameworks. Failure attribution on agent traces is a research and tooling area of its
own, listed below.

| Project | What it is | What agent-plexus adds | Pick it when |
|---|---|---|---|
| Oracle Agent Spec | A declarative, framework-neutral format for agents and flows, run by the runtime of a framework | Limits enforced on every member call, attribution of a failed run, members that are not described in the format (any A2A agent) | You want one portable definition of agents and flows and a framework runtime to execute it |
| agentgateway | A proxy for agent traffic (A2A, MCP): connectivity, security, observability of the calls | The topology, routing, durable runs and attribution between the agents; agentgateway can sit in front as the host's exposure | You need a data plane in front of agents and tools, not the composition of a system |
| a2a-mesh | Plumbing for agents that speak A2A: servers, clients, discovery | A topology over the agents, bounds that travel with each call, members that are not A2A agents (functions, agent-layers stacks) | Every agent already speaks A2A and you need the transport and discovery pieces |
| LangGraph supervisor and swarm | Multi-agent patterns of LangGraph: a supervisor that hands work to agents, or agents that hand off to each other | Members from other frameworks under the same limits; one place where a failure is attributed | Every agent is a LangGraph graph and you want LangGraph's checkpoints and tooling |
| Mastra supervisor | A Mastra agent that delegates to other Mastra agents | The same, for agents outside Mastra | Every agent is a Mastra agent in one TypeScript application |
| ag2tracer (PyPI) | Attributes a failure in a multi-agent trace to an agent and a step (who and when); we have not evaluated it | Cheap deterministic rules at no model cost, bounds on every call; the rules catch hard failures only, so a wrong answer from a run that completed is a low-confidence guess | You need to find the responsible agent and step in a trace of a wrong answer |
| AgentDebugX | A tool for failure attribution on agent traces; we have not evaluated it | The same: deterministic rules, hard failures only, plus the composition and the limits | You need trace-based diagnosis of failed multi-agent runs |
| Who&When benchmark (arXiv 2505.00212) | A benchmark task for who and when failure attribution in multi-agent systems; the reference task, not a tool | Nothing: agent-plexus has not been scored on it, and its rules are not meant to solve it | You want to measure an attribution method |
| Microsoft Agent Framework workflows | Graph workflows of agents and functions, with checkpoints and human approval, in .NET and Python | Members of any framework under shared limits; attribution | Your agents are built with Microsoft Agent Framework |

**When not to use agent-plexus:** one framework and one team. If every agent is written in the same framework and
deployed together, its own multi-agent pattern is simpler; agent-plexus earns its place when the agents come from
different frameworks, teams or processes.
