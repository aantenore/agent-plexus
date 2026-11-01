# Landscape: what exists, what agent-plexus adopts, what it owns

Research date: 2026-11-01. Detail, versions and sources: [frameworks.md](frameworks.md) (orchestration frameworks,
durable execution, declarative formats) and [protocols.md](protocols.md) (A2A, MCP, delegation identity, propagation
prior art, multi-agent evaluation). Items marked "unverified" there were not confirmed against a primary source.

## Conclusion first

agent-plexus is mostly adapters, and it owns less than an agent stack does. Every framework below can be a member
without an adapter here, because it can serve A2A. Control and insight (identity, policy, content checks, telemetry,
scoring, exposure) are not rebuilt: they come from a host, agent-layers being the reference one. What nobody
provides, and agent-plexus has to own, is the space between agents: how an agent is called, discovery, routing
between agents, a topology described as data, durable runs across member calls, and fault attribution across agents.

## Frameworks

| Name | License | Languages | Orchestration model | Interop | Role in agent-plexus |
|---|---|---|---|---|---|
| LangGraph / LangGraph.js | MIT (libraries); Agent Server `langgraph-api` Elastic-2.0, not used | Python, TS | Checkpointed graph, `Send`, `Command`, `interrupt` | A2A (Agent Server only), MCP client, Agent Protocol | Member over A2A; LangGraph.js as a TopologyPort adapter candidate; borrow checkpoint and interrupt semantics |
| CrewAI | MIT (AMP commercial, not used) | Python | Crews (roles, hierarchical manager), Flows (events, router, persist) | A2A client and server, MCP | Member over A2A only |
| AG2 v1 | Apache-2.0 | Python | Network with a Hub: registry, write-ahead log, audit, typed channels | unverified | Ideas only (hub log and audit) |
| AutoGen | MIT code, CC-BY-4.0 docs | Python, .NET | Actors, group chat | | Ignore: no longer maintained |
| Microsoft Agent Framework | MIT | .NET, Python, Go preview | Graph workflows; sequential, concurrent, handoff, group chat, Magentic manager | A2A, MCP, OpenTelemetry | Member over A2A; reference for the pattern taxonomy |
| Google ADK | Apache-2.0 | Python, TS, Go, Java, Kotlin | Sequential, Parallel, Loop agents; LLM transfer; graph workflows (2.0) | A2A (experimental), MCP | Member over A2A; ADK-TS as a TopologyPort adapter candidate; its three workflow agents are the minimum topology vocabulary |
| OpenAI Agents SDK | MIT | Python, JS | Loop, handoffs (transfer control), agents as tools (call and return) | MCP; no A2A | Member (JS in process as an agent-layers runtime); borrow the handoff/agent-as-tool split and input filters |
| Strands Agents | Apache-2.0 | Python, TS | Agents as tools, swarm, graph, workflow | A2A, MCP, OpenTelemetry | Member; TopologyPort adapter candidate; borrow swarm limits (handoffs, iterations, total and per-node time, repeated-handoff detection) |
| Mastra | Apache-2.0 core; `ee/` proprietary, not used | TS | Graph workflows, supervisor with delegation hooks | MCP | Member; borrow "limits can only be lowered" delegation hooks |
| Pydantic AI | MIT | Python | Delegation through tools, graph FSM | A2A, MCP | Member over A2A; borrow usage propagation from delegate to parent |
| Vercel AI SDK / Workflow DevKit | Apache-2.0 | TS | Loop agent; durable workflows | MCP (unverified) | Member; durable execution candidate |
| LlamaIndex Workflows, BeeAI, Dapr Agents, Agno, VoltAgent | MIT / Apache-2.0 | mostly Python | Event steps, workflows, pub/sub, teams | varies | Members over A2A where they serve it; ideas (event-driven topology, pub/sub) |
| kagent, Docker cagent | Apache-2.0 | Go | Kubernetes CRDs, YAML teams, OCI-packaged agents | A2A, MCP | Deployment and registry ideas; possible registry adapter (CRDs) |
| Letta, CAMEL-AI, Swarms | Apache-2.0 | Python | memory agents, research, marketing-led | | Ignore |

Recurring patterns, which become the vocabulary of the topology port: sequence, parallel fan-out and fan-in, loop
with a bound, route to one member, delegate (call and return), handoff (transfer control), supervisor (a member
that delegates dynamically), graph with conditional edges, checkpoint and resume for human input.

## Durable execution

| Engine | License | Fit |
|---|---|---|
| Temporal | MIT (server and SDKs) | Production ExecutionPort adapter candidate; integrations exist for several agent SDKs |
| DBOS | MIT | Embedded ExecutionPort adapter candidate: a library on Postgres or SQLite, no server |
| Hatchet | MIT | Alternative candidate |
| Restate | Server BUSL-1.1 (not OSI), SDKs MIT | Not a reference; an operator may write an adapter |
| Inngest | Server SSPL-1.0 (not OSI) | Avoid |

## Standards

| Standard | Status | What agent-plexus does with it |
|---|---|---|
| A2A 1.0.1 (Linux Foundation, Apache-2.0) | Stable; SDKs in TS, Python, Java, Go | The wire between agents, through the `a2a-member` adapter and the host's exposure. Agent cards (skills, security schemes, JWS signatures) feed the registry. Extensions (`capabilities.extensions`, `A2A-Extensions`, metadata keyed by extension URI) carry bounds and lineage. A2A defines no registry API, no deadline, budget, hop limit or delegation chain. |
| MCP 2026-07-28 | Stable; stateless; Tasks is an extension; sampling deprecated | Tools and knowledge of the members themselves. An agent behind MCP is a member only as a tool. `_meta` carries bounds. Token passthrough is forbidden, so every hop exchanges a token for the next audience. |
| RFC 8693 token exchange, `act` | RFC | The verified delegation chain, read by the host's gate. Outermost `act` is the current actor; prior actors are informational for access control. Gives an audit trail, not depth enforcement. |
| RFC 8707, RFC 9728, RFC 9449 (DPoP) | RFCs | Audience binding and sender-constrained tokens per hop, in the host's gate. |
| Transaction tokens (draft -11), identity chaining (draft -17, RFC Editor queue), WIMSE | Drafts | Track; adapters later. No agent delegation draft is adopted by a working group; one individual draft has a signed hop limit (`del_max_depth`). |
| gRPC `grpc-timeout`, SIP `Max-Forwards`, Envoy expected timeout | Established practice | The model for bounds: send remaining time, decrement hops, typed refusal, retries share the deadline. |
| W3C Trace Context | Recommendation | Correlation across agents, carried by the telemetry adapters. |
| W3C Baggage | Candidate Recommendation | Not used for bounds or identity: forwarded to third parties, changeable by any hop. |
| OpenTelemetry GenAI conventions (`invoke_agent`, `invoke_workflow`, `a2a.*`, `mcp.*`) | Development | Mapped by the OTLP telemetry adapter; agent-plexus names stay in its own `plexus.*` namespace. No convention for the delegating agent, the hop index or a fault verdict. |

## Discovery

| Option | License, status | Fit |
|---|---|---|
| Well-known agent card (`/.well-known/agent-card.json`) | A2A 1.0 | Reference registry adapter (cards listed in config, fetched, pinned, signatures checked) |
| AGNTCY Agent Directory + OASF | Apache-2.0, v1.8.0 / v1.1.0 | Registry adapter candidate; OASF skill taxonomy is the best structured capability vocabulary found |
| AI Catalog (`/.well-known/ai-catalog.json`) | Linux Foundation working repo, no version | Track |
| MCP Registry | Apache-2.0 (transition from MIT), preview | MCP servers only: for tools, not members |
| IETF DAWN | Working group, protocol milestone 2027 | Track; excludes capability catalogs and search |
| Kubernetes CRDs (kagent) | Apache-2.0 | Registry adapter candidate for cluster deployments |
| Vendor registries (Microsoft Agent 365, Google Cloud Agent Registry) | Proprietary | An operator may write an adapter; not a reference |

A2A skills are free text and tags without cost, latency or SLA fields, so routing metadata is agent-plexus' own,
carried in the registry entry and, on the wire, in an A2A extension of the card.

## Evaluation and attribution

| Item | Fact | Consequence |
|---|---|---|
| Who&When (ICML 2025) | Best automated method finds the failing agent 53.5% of the time and the failing step 14.2% | Attribute to an agent first; a step is a hint |
| MAST | 14 failure modes in three groups: specification, inter-agent misalignment, verification and termination | Attribution categories |
| AgenTracer (ICLR 2026) | Counterfactual replay and fault injection beat reading logs | A replay harness is worth owning; structured hop records beat log text |
| Tools | promptfoo, Inspect AI (MIT); DeepEval, OpenLLMetry (Apache-2.0); Langfuse (MIT core); Phoenix (Elastic-2.0, excluded) | Scoring through the host's score hook; none attributes across A2A or MCP hops |

## Adopt or own

| Concern | Where | Adopt | Own |
|---|---|---|---|
| Running one agent | L0 `member` | Any framework over A2A; agent-layers stacks; functions | MemberPort, `MemberResult` |
| Wire between agents | L0 `member` | A2A 1.0 through the official JS SDK | Nothing: the bounds extension is the agent-layers proposal's |
| Discovery | L1 `registry` | Agent cards, AGNTCY directory, Kubernetes CRDs | RegistryPort, `AgentEntry` |
| Routing | L2 `routing` | Models over OpenAI-compatible endpoints, search backends, agent-layers models and knowledge | AgentRouterPort and its rules |
| Topology | L3 `topology` | LangGraph.js, ADK-TS, Strands TS as engines | `TopologySpec`, the reference executor, `memberCall` |
| Durable execution | L4 `execution` | DBOS, Temporal, Hatchet; a host's state | ExecutionPort and the reference journals |
| Cross-agent attribution | L5 `attribution` | Research methods (Who&When, AgenTracer) | `HopRecord`, AttributionPort, reference rules |
| Identity, policy, content checks | host `gate` | agent-layers (OIDC, RFC 8693, OPA, AuthZEN, Presidio, LLM Guard) | The hook, nothing more |
| Telemetry, scoring | host `telemetry`, `score` | agent-layers telemetry and evaluators; OpenTelemetry, promptfoo | `plexus.*` names |
| Exposure | host | The agent-layers gateway | Nothing |
| Deadline, budget, hops | host + core | The agent-layers proposal; practice from gRPC and SIP | System limits only |
