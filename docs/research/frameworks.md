# Multi-agent orchestration frameworks: adopt vs own (research as of 2026-11-01)

Method: GitHub API (`gh api`, repo metadata + latest release), official docs via WebFetch, A2A spec fetched locally and grepped. "unverified" = not confirmed in a source read. Star counts are from GitHub at fetch time.

Evaluation lens: neutral `Topology/Orchestrator` port (hexagonal, TS-first, language-neutral spec), each agent = whole stack behind in-process / A2A / MCP / OpenAI-compatible HTTP.

---

## 1. LangGraph (Python) + LangGraph.js + Platform/Server + Agent Protocol

- Version/date: langgraph (py) 1.2.19, 2026-10-30. LangGraph.js repo pushed 2026-11-01 (release tags are per-package, e.g. `@langchain/react@1.2.9` 2026-10-30; core `@langchain/langgraph` exact version unverified).
- License: library MIT (py, js, `langchain-ai/agent-protocol` MIT). **Non-OSI part: `langgraph-api` (Agent Server runtime) is Elastic-2.0 per PyPI (v0.17.0)**. Standalone/self-hosted server docs say it "requires a LangSmith license"; Cloud/BYOC/Hybrid/self-hosted-with-control-plane are commercial plans (Plus/Enterprise). Forum/third-party reports disagree on whether the core server runs without a key (unverified; treat server as non-OSI).
- Languages: Python, TypeScript. (JS has Agent Protocol in-memory OSS server `langgraphjs-api`.)
- Maintenance: ~44k stars (py), ~3.4k (js); released every few days; backed by LangChain Inc. Very active.
- Orchestration model: stateful graph / state machine (Pregel/BSP supersteps). Nodes, conditional edges, `Send` (dynamic fan-out/map-reduce), `Command(update, goto, graph, resume)`, subgraphs (`Command.PARENT`). Supervisor/swarm patterns are separate libs (`langgraph-supervisor-py` is **archived**, 2026-07). `deepagents` (MIT, ~31k stars) is the batteries-included harness on top.
- Addressing/discovery: nodes by name inside a graph; across processes via Agent Server: assistants (config), threads (state), runs; `RemoteGraph` to call a deployed graph as a subgraph. A2A endpoint `/a2a/{assistant_id}` (A2A v1.0 JSON-RPC binding + v0.3 method names; no SubscribeToTask/push yet, JSON-RPC only; contextId -> thread_id). MCP endpoint in Agent Server: not found in docs read (unverified).
- State/checkpoints/HITL: checkpointer per superstep (sqlite/postgres/etc.), thread_id, time-travel; `interrupt()` + `Command(resume=)` (node re-executes from start on resume); static `interrupt_before/after`. Strongest durable-HITL story among the in-process libs.
- Limits: `recursion_limit` per run (default 10,007 steps in >=1.1.4; `GraphRecursionError`; `RemainingSteps` managed value for graceful stop). No wall-clock deadline or token/cost budget in core (unverified beyond docs read). Not propagated across RemoteGraph/A2A hops.
- Delegation identity: Agent Server custom auth (`@auth.authenticate` returns identity dict -> `config.configurable.langgraph_auth_user`; `@auth.on` per-resource filters). Pattern = load user's 3rd-party tokens into user object. **No formal delegation/token-exchange/on-behalf-of chain.**
- Tracing/eval: LangSmith (commercial SaaS; OTel ingest/export exists but not verified). Open: OTel via third-party instrumentation (unverified).
- Interop: A2A server (Agent Server only), MCP client via adapters; Agent Protocol (runs/threads/store REST; "Agent Streaming Protocol" CDDL bindings, package `langchain-protocol` 0.0.20 on 2026-10-20). Agent Protocol = LangChain-led spec, MIT, 692 stars; effectively a LangGraph-platform API, not a cross-vendor standard.
- Integration cost as adapter: LangGraph.js is in-process TS -> cheap adapter (wrap compiled graph as an "agent" node or as a Topology engine). Python needs sidecar (HTTP via Agent Protocol / A2A). Graph state schema is engine-specific -> adapter must map only input/output + interrupts.
- Verdict: **adopt-as-adapter (as an agent-stack implementation reachable via A2A/Agent Protocol, and optionally a JS in-process topology engine); borrow-idea (checkpoint+interrupt semantics, Send, Command)**. Do NOT depend on Agent Server (Elastic-2.0 / license key).

## 2. CrewAI (crews vs flows)

- Version: 1.15.33, 2026-10-29 (PyPI metadata license field null; README/GitHub says MIT).
- License: MIT (code). Enterprise "AMP" is commercial (docs steer production A2A/distributed state to AMP).
- Language: Python only (3.10-3.13). ~60k stars, VC-backed company (CrewAI Inc), very active.
- Model: **Crews** = role-based agents + tasks, sequential or hierarchical manager process (process docs not fetched; unverified detail), LLM-driven delegation (`allow_delegation`, default False). **Flows** = event-driven DAG-ish control (`@start`, `@listen`, `or_/and_`, `@router`) with typed Pydantic state; recommended: Flow outside, Crews inside.
- Addressing: in-process objects; remote via A2A config (`A2AClientConfig(endpoint=agent card URL)`, LLM picks delegate among several).
- State/HITL: `@persist` (SQLite default, custom backends), resume by flow id (`kickoff(inputs={"id":..})`), fork via `restore_from_state_id`, `@human_feedback` (>=1.8.0).
- Limits: agent `max_iter` 20, `max_rpm`, `max_execution_time` (seconds, default None), `max_retry_limit` 2; A2A `timeout` 120s, `max_turns` 10. Per-agent, not propagated cross-agent. `flow.usage_metrics` aggregates tokens (reporting, not enforcement).
- Delegation identity: A2A client auth schemes (bearer, API key, OAuth2 client credentials/auth code, basic, digest, mTLS not listed); no identity chain across delegations.
- Tracing: integrations (Langfuse, Phoenix, MLflow, OpenLIT, Opik, Weave, ...). Native OTel not claimed in docs read (unverified). 
- Interop: A2A client+server (server protocol_version default 0.3.0; JSONRPC/gRPC/HTTP+JSON), MCP (docs not fetched; widely known, unverified here).
- Adapter cost: Python-only -> sidecar (A2A server mode is the natural boundary). Engine internals not worth wrapping.
- Verdict: **adopt-as-adapter only as an agent stack behind A2A; borrow-idea (Flow @router/@persist ergonomics, human_feedback routing)**. Not a topology engine candidate.

## 3. AG2, Microsoft AutoGen, Microsoft Agent Framework

### AG2 (ag2ai/ag2)
- Version: v1.2.2, 2026-10-27. License: **Apache-2.0** (README notes fork lineage/NOTICE; earlier AutoGen code was MIT/CC). ~5k stars; volunteer group from several orgs; active.
- Language: Python (>=3.10). **v1.0 is a rewrite, not drop-in**: `pip install ag2`, import `ag2`; legacy `autogen.*` GroupChat/swarm moved to `ag2ai/ag2-classic` (still maintained).
- v1 model: Agent + tools + HITL; **Network with Hub** (agent registry, write-ahead log, audit trail, typed channels): `conversation`, `consulting`, `discussion` (round-robin), `workflow` (TransitionGraph handoffs). Interesting registry+WAL+audit idea (v1 docs light, unverified in depth).
- A2A/MCP/OTel: not stated in README/docs read (unverified).
- Verdict: **borrow-idea-only** (Hub registry + WAL + audit trail; channel types). Too young/rewritten, Python-only.

### Microsoft AutoGen (microsoft/autogen)
- Last release python-v0.7.5, 2025-09-30. README: **no longer actively maintained; no bug/security fixes; points to Agent Framework as "enterprise-ready successor"; archived/maintenance notice** (GitHub flag archived=false but pushed 2026-10-28 -> README/migration changes). License: code MIT, docs CC-BY-4.0 (GitHub SPDX shows CC-BY-4.0 for repo; code is MIT per README). ~62k stars.
- Verdict: **ignore** (dead; use only as design reference: actor model, GroupChat, Magentic-One).

### Microsoft Agent Framework (microsoft/agent-framework)
- Version: python-1.24.0, 2026-10-30; **1.0 GA announced ~2026-04-03** (Microsoft techcommunity post per search; companion packages still show beta/alpha suffixes e.g. 1.0.0b261030). Go port in public preview (`agent-framework-go`, MIT, Go 1.26+).
- License: MIT. ~14.5k stars; Microsoft-backed; very active. Languages: .NET, Python, Go (preview).
- Model: graph-based **workflows** (superstep, checkpointing, time-travel) + built-in orchestrations: Sequential, Concurrent, Handoff, Group Chat, **Magentic** (manager). Functional workflows too. "Harness Agent" for long tasks (planning/todos, compaction, tool approval).
- Addressing: agent objects/sessions; A2A hosting samples (Python+.NET); Foundry hosted agents; declarative YAML agents.
- State/HITL: checkpointing, request/response HITL via approval-required tools; durable extension (Durable Task / Azure Functions samples).
- Limits: "bounded looping" docs exist (Go); orchestration max rounds/termination configurable; exact cross-agent budget propagation unverified (probably none).
- Identity: Azure/Entra credentials per client; no agent-to-agent delegation chain verified (unverified).
- Tracing: built-in OpenTelemetry (README). Interop: A2A, MCP clients, OpenAI-compatible providers.
- Adapter cost: .NET/Python/Go only -> no TS in-process; sidecar or A2A. Semantic Kernel: maintenance mode (secondhand: Atlan; unverified).
- Verdict: **borrow-idea (Magentic manager, superstep checkpoint, HITL request/response model) + adopt-as-adapter via A2A for agents that happen to be .NET/Python MAF.** Strongest enterprise-backed reference for orchestration pattern taxonomy.

## 4. Google ADK

- Python 2.13.0 (2026-10-23, 22k stars, Apache-2.0); Java 1.13.0 (2026-10-21, 1.8k); Go 2.6.0/1.9.0 line (2026-10-15, 8.9k); **TypeScript (adk-js, Apache-2.0, 1.5k stars) release `main-v2.4.0` 2026-10-28; docs say "ADK TypeScript 2.0 GA"**; Kotlin listed on A2A page. All Apache-2.0, Google-backed, very active. Docs moved to adk.dev.
- Model: workflow agents `SequentialAgent`, `ParallelAgent`, `LoopAgent` (max_iterations; exact default not read, unverified) as `BaseAgent` subclasses; LLM-driven transfer / sub_agents hierarchy and AgentTool (docs page on hierarchy not read; known pattern, unverified here). **ADK 2.0: graph-based workflows, dynamic (code) workflows, collaborative coordinator, experimental agent routing.** Source also has `remote_a2a_agent.py`, `_agent_router.py`, `langgraph_agent.py`.
- Addressing: agent `name` unique within tree; shared session state keys (`output_key`); remote via A2A `RemoteA2aAgent` (Python/Go/Java/Kotlin) and expose via to_a2a. **A2A integration flagged "Experimental"** in docs.
- State: sessions/state/memory services, events; Resume Agents page exists (not read; unverified).
- Limits: `RunConfig.max_llm_calls` default 500 (0/negative = unlimited). Per run, not cross-agent budget.
- Identity: sessions keyed by user_id; auth for tools (OAuth) exists; no delegation chain verified.
- Tracing/eval: logging/metrics/traces (Cloud Trace named; OTel plausible - `telemetry` module exists, unverified), built-in eval framework + user simulation. Interop: A2A + MCP tools.
- Adapter cost: **TS exists (in-process) -> cheap adapter**; Python/Go/Java via A2A. Deploys on Cloud Run/GKE/Agent Runtime. LangSmith lists ADK as wrappable.
- Verdict: **adopt-as-adapter (as agent stack in 5 languages, A2A-exposable) and borrow-idea (Sequential/Parallel/Loop primitives as the minimal topology vocabulary)**. Cleanest multi-language Apache-2.0 option.

## 5. OpenAI Agents SDK (Python + JS)

- Python v0.24.0, 2026-10-15 (MIT, ~30k stars). JS `@openai/agents@0.21.0`, 2026-10-20 (MIT, ~4k). OpenAI-backed, very active. Despite name, supports non-OpenAI models (LiteLLM etc.; not re-verified).
- Model: agent loop (LLM call -> tools/handoffs -> repeat). **Handoffs** = tools `transfer_to_<agent>`, transfer control; `input_filter`, `on_handoff`, `input_type`, `is_enabled`, opt-in `nest_handoff_history` (beta). **Agents-as-tools** `Agent.as_tool(parameters=...)` keeps control with caller.
- Addressing: in-process objects only; no registry/discovery. Exposed to MCP as client (stdio/SSE/streamable HTTP); no A2A in JS content read.
- State/HITL: Sessions (history), `RunState` serialization for tool-approval pause/resume, `cancel(mode="after_turn")`. No checkpoint of the loop; durable via **Temporal, Restate, DBOS** integrations.
- Limits: `max_turns` (`MaxTurnsExceeded`; `max_turns=None` disables; default value not stated in page read, widely 10 - unverified), `error_handlers` for max_turns/model_refusal/invalid_final_output. No wall-clock/cost budget.
- Guardrails: input (first agent only, parallel by default or blocking), output (last agent only), tool guardrails (per function tool, incl. MCP servers; not handoffs). Tripwire exceptions.
- Identity: none (user context object `RunContextWrapper.context`).
- Tracing: on by default to OpenAI backend (disabled under ZDR), pluggable `TracingProcessor`; ~35 third-party processors (Langfuse, Phoenix, Datadog, ...); **OTel not named** in tracing page. `trace_include_sensitive_data` default True.
- Adapter cost: JS in-process -> trivial as an agent stack; very small, clean surface. Python sidecar otherwise.
- Verdict: **adopt-as-adapter (as agent stack) + borrow-idea (handoff-as-tool, input_filter at boundary, tripwire guardrails, error_handlers)**. Handoff model is "transfer control", which the Topology port should model as one edge type.

---

## 6. Others (brief)

| Name | Version/date | License | Notes |
|---|---|---|---|
| **Mastra** (TS) | `@mastra/core@1.80.0`, 2026-10-28; ~29k stars; Kepler Software Inc. | **Apache-2.0 + `ee/` dirs under separate Mastra Enterprise license (non-OSI)**; GitHub shows NOASSERTION | TS graph workflows (`.then/.branch/.parallel`), suspend/resume HITL, supervisor "subagents" with delegation hooks (`onDelegationStart` can reject/rewrite/set `maxSteps`; `maxSteps` can only be lowered by supervisor, `bail()`), MCP server exposure, evals, observability. A2A not found (unverified). Best TS-native delegation-hook design. Adapter: in-process TS, cheap; avoid `ee/` code. Verdict: **adopt-as-adapter (agent stack) + borrow-idea (delegation hooks / budget narrowing)**. |
| **VoltAgent** (TS) | `@voltagent/core@2.11.0`, 2026-09-28; ~11k | MIT | Supervisor/sub-agents, workflows with suspend/resume, MCP; VoltOps console (commercial/hosted+self-host). A2A, OTel not found. Verdict: ignore/low priority (agent stack at most). |
| **Strands Agents** (AWS) | Python 1.63.0 / TypeScript 1.23.0, 2026-10-30 (repo renamed `strands-agents/harness-sdk`; old `sdk-typescript` archived); ~9k | Apache-2.0 | Py+TS. Agents-as-tools, Swarm, Graph, Workflow; Swarm defaults: 20 handoffs, 20 iterations, 900 s total, 300 s per node, repetitive-handoff detection; lifecycle controls "turn limits, token budgets, cancellation"; OTel (opentelemetry-api/sdk deps, otlp extra); A2A extra in pyproject; MCP; Temporal plugin. **Best hop/timeout/ping-pong controls found.** AWS-backed, very active. Verdict: **adopt-as-adapter (TS in-process) + borrow-idea (swarm limits, repetition detection)**. |
| **Pydantic AI** (+pydantic-graph) | v2.64.0, 2026-10-30; ~21k; Pydantic Services | MIT | Delegation via tools; programmatic hand-off; graph FSM for complex. **`UsageLimits(request_limit, tool_calls_limit, total_tokens_limit, cost_limit)` and `usage=ctx.usage` propagates usage from delegate to parent (in-process)**; breaks across Temporal activities (copy of context). Durable: Temporal, DBOS, Prefect, Restate. A2A via fasta2a, AG-UI, OTel/Logfire (from memory, unverified). Python only. Verdict: **borrow-idea (usage propagation/budget object)**, adapter via A2A. |
| **LlamaIndex Workflows / Llama Agents** | `llama-agents@0.12.8` 2026-10-23; workflows-py ~0.5k stars (llama_index 52k) | MIT | Event-driven async steps; pluggable durability; `llama-agents-server` REST with streaming/HITL; `llamactl` deploy (LlamaParse/Bedrock AgentCore/self-host). TS version unverified. A2A not mentioned. Verdict: borrow-idea (event-step model); low adapter priority. |
| **BeeAI Framework** | python_v0.1.85 2026-09-28; ~3.4k | Apache-2.0 | Py+TS, Linux Foundation AI & Data (IBM-origin); workflows; serve over A2A and MCP; ACP merged into A2A. Verdict: ignore/borrow-idea (A2A serving helpers). |
| **Dapr Agents** | v1.1.0, 2026-10-27; ~0.8k | Apache-2.0 | CNCF/Dapr durable workflow engine (actors), pub/sub multi-agent, mTLS, MCPServer auto-discovery from sidecar. Python only; A2A not mentioned. Verdict: **borrow-idea** (pub/sub event-driven topology + durable workflow substrate; infra-heavy: needs Dapr sidecar). |
| **kagent** (CNCF) | v1.0.0-rc1, 2026-10-30; ~4k | Apache-2.0 | K8s CRDs (Agent, AgentTemplate, ModelConfig, RemoteMCPServer); controller talks A2A to agent runtimes (Go/Python ADK, vendor CLIs, custom); exposes gRPC/A2A/MCP. Not an orchestrator; a **deployment/registry layer**. Verdict: **borrow-idea (declarative CRD agent registry; A2A as runtime contract)**; deploy target. |
| **Letta** | 0.16.8 2026-05-14 (legacy server); active source moved to `letta-code` | Apache-2.0 (letta repo) | Stateful memory agents; legacy V1 API server retired to `archive` branch; multi-agent tools not verified. Verdict: ignore for orchestration; memory idea only. |
| **CAMEL-AI** | v0.2.90, 2026-03-22; ~18k | Apache-2.0 | Research-oriented (Workforce, RolePlaying, OWL). Release cadence slowed. Verdict: ignore. |
| **Swarms** (kyegomez) | latest GH "release" 6.8.1 from 2024-12 (PyPI cadence unverified); ~7k | Apache-2.0 | Claims 60+ structures; hosted marketplace/X402; no A2A; unsubstantiated "99.9% uptime" marketing. Verdict: ignore. |
| **Agno** | v3.1.12, 2026-10-29; ~43k | Apache-2.0 | Agents/Teams/Workflows, "AgentOS" runtime service with API, MCP server, RBAC, resume/replay, scheduling, HITL approval. A2A not mentioned. Verdict: borrow-idea (AgentOS as runtime/service contract); optional agent stack. |
| **Vercel AI SDK** | `ai` monorepo; ~28k; Vercel | Apache-2.0 (LICENSE file is Apache 2.0; GitHub shows NOASSERTION) | TS. `ToolLoopAgent`, `stopWhen`/`prepareStep` loop control, `runtimeContext`/`toolsContext`, HarnessAgent; **Workflow DevKit** (`vercel/workflow`, Apache-2.0, `workflow@5.2.3` 2026-10-20) for durable; `eve` durable agent framework. Subagents/OTel/MCP/A2A not verified. Verdict: **adopt-as-adapter (provider layer + TS agent loop)**, WDK a durability candidate. |
| **Deep Agents** (LangChain) | `deepagents==0.7.32` 2026-10-23; ~31k | MIT | Harness over LangGraph with subagents; async-subagent server example implementing Agent Protocol. Borrow-idea. |

### Durable-execution engines

| Engine | Version | License (exact) | Notes |
|---|---|---|---|
| **Temporal** | server v1.32.1 (2026-10-08); sdk-typescript v1.25.0, sdk-python 1.35.0 | MIT (server + SDKs); Temporal Cloud commercial | Agent integrations: OpenAI Agents SDK, Strands, Google ADK, Pydantic AI, Vercel AI SDK; HITL via Signals. Heaviest ops. Gold standard for durable orchestration of agent calls. Verdict: **adopt-as-adapter (durable-execution port)**. |
| **Restate** | server v1.8.1 (2026-10-21) | **Server: BUSL-1.1** (Additional Use Grant forbids a public Restate Platform Service) - non-OSI; **SDKs (TS, Python): MIT** | Lightweight single binary; Pydantic AI + OpenAI Agents integrations. BUSL risk for OSS distribution only if bundling/hosting. Verdict: optional adapter; flag license. |
| **Inngest** | server v1.49.0 (2026-10-23) | **SSPL-1.0 with Apache-2.0 future license (DOSP)** - non-OSI; `inngest-js` license reported as GPL-3.0 by GitHub API (unverified; verify before use); `agent-kit` Apache-2.0, last release 2025-11 (stale) | Verdict: avoid as a hard dependency. |
| **DBOS** | transact-py 3.4.0 (2026-10-28); transact-ts v5.4 | MIT | Library + Postgres/SQLite, no server; integrated by OpenAI Agents SDK and Pydantic AI. Lowest-footprint durable option. Verdict: **adopt-as-adapter candidate (embedded durability)**. |
| **Hatchet** | v0.114.2 (2026-10-26); ~8k | MIT | Postgres-backed task/durable workflow engine, Python/TS/Go/Ruby SDKs. Verdict: viable alternative. |

### Declarative multi-agent spec formats

- **Oracle Open Agent Spec ("Agent Spec")**: `agent-spec-26.3.1` (2026-09-11), **Apache-2.0 OR UPL-1.0**, ~450 stars. Declarative JSON/YAML for Agents and Flows; `pyagentspec` SDK (Python only today); adapters for LangGraph, AutoGen, CrewAI; WayFlow = Oracle reference runtime. Multi-agent component names (ManagerWorkers/Swarm/A2A agent) and versioning not verified. Verdict: **borrow-idea / track** (closest thing to a portable agent+flow description; Oracle-led, small adoption).
- **AGNTCY OASF** (`agntcy/oasf` v1.1.0, 2026-07-10; Apache-2.0; ~340 stars): schema (OCSF-inspired) for agent records with skills/domains taxonomies, extensions; maps to A2A Agent Cards; companion `agntcy/dir` (v1.8.0, Apache-2.0) distributed directory. Governance foundation not stated in README (AGNTCY is known to be under Linux Foundation; unverified here). Verdict: **borrow-idea for capability taxonomy/discovery metadata**.
- **Docker cagent / "Docker Agent"** (`docker/cagent` v1.154.0, 2026-10-28; Apache-2.0; ~4.6k): YAML agent definitions (model, instruction, toolsets), multi-agent delegation, MCP toolsets, push/pull agents via OCI registries. A2A not mentioned. Verdict: **borrow-idea (OCI-distributed declarative agent artifacts)**.
- **LangGraph Agent Protocol**: REST (runs/threads/store) + streaming protocol; MIT; LangChain-led (see section 1).
- **A2A** (`a2aproject/A2A` v1.0.1, 2026-05-28; Apache-2.0; ~26k): see below. **MCP**: spec release 2026-07-28; licensing transitioning MIT -> Apache-2.0 (docs CC-BY-4.0).

---

## A2A v1.0 facts relevant to us (spec)

- Agent Card (identity, capabilities, skills, interfaces, securitySchemes, **signed cards**), optional `tenant` routing id, extensions (`A2A-Extensions` header), bindings JSON-RPC / gRPC / HTTP+JSON, version negotiation header.
- Task states: SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED. AUTH_REQUIRED can be re-delegated up the chain ("in-task authorization").
- Auth: API key, HTTP, OAuth2 (code, client creds, device), OIDC, mTLS.
- **Not in spec (grepped): deadline/timeout propagation, budget, hop/depth limit, trace-context propagation requirement, on-behalf-of / actor-chain identity.** Only webhook timeout recommendations (10-30s).
- SDKs: python v1.3.0 (2026-10-27), js v1.3.0 (2026-09-29), Apache-2.0.

---

## Summary comparison

| Name | License | Lang | Model | Interop | Maintenance | Verdict |
|---|---|---|---|---|---|---|
| LangGraph (+JS) | MIT lib; **Server Elastic-2.0 / license key** | Py, TS | Checkpointed graph, Send, Command, interrupt | A2A (server), Agent Protocol, MCP client | Very active, 44k / 3.4k stars | Adapter (agent stack, JS engine); borrow checkpoint/interrupt; avoid Server |
| CrewAI | MIT (AMP commercial) | Py | Crews (roles) + Flows (events) | A2A client+server, MCP | Very active, 60k | Adapter via A2A only; borrow Flow router/persist |
| AG2 v1 | Apache-2.0 | Py | Network Hub + channels | unverified | Active, small (5k), rewrite | Borrow Hub/WAL/audit |
| AutoGen | MIT code / CC-BY-4.0 docs | Py, .NET | Actors, GroupChat | - | **Unmaintained** | Ignore |
| MS Agent Framework | MIT | .NET, Py, Go(preview) | Graph workflows + 5 orchestrations incl. Magentic | A2A, MCP, OTel | GA Apr 2026; very active | Borrow patterns; adapter via A2A |
| Google ADK | Apache-2.0 | Py, TS, Go, Java, Kotlin | Seq/Par/Loop + LLM transfer + graph (2.0) | A2A (experimental), MCP | Very active, Google | Adapter (TS in-process + A2A) |
| OpenAI Agents SDK | MIT | Py, JS | Loop, handoffs, agents-as-tools | MCP; no A2A | Very active, 30k | Adapter (JS in-process); borrow handoff/guardrails |
| Mastra | Apache-2.0 + `ee/` proprietary | TS | Graph workflows + supervisor | MCP | Very active, 29k | Adapter; borrow delegation hooks |
| VoltAgent | MIT | TS | Supervisor + workflows | MCP | Active, 11k | Ignore |
| Strands | Apache-2.0 | Py, TS | Tools/Swarm/Graph/Workflow | A2A, MCP, OTel | Very active, AWS | Adapter + borrow limits |
| Pydantic AI | MIT | Py | Delegation + graph FSM | A2A (fasta2a), MCP, AG-UI | Very active | Borrow UsageLimits propagation |
| LlamaIndex Workflows | MIT | Py | Event steps | MCP (partial) | Active | Borrow event model |
| BeeAI | Apache-2.0 | Py, TS | Workflows | A2A, MCP | Active, LF | Ignore |
| Dapr Agents | Apache-2.0 | Py | Durable workflows + pub/sub | MCP | Active, CNCF | Borrow pub/sub + durability |
| kagent | Apache-2.0 | Go/Py | K8s CRD registry | A2A, MCP | rc1, CNCF | Borrow declarative registry |
| Letta / CAMEL / Swarms | Apache-2.0 | Py | memory / research / marketing-heavy | - | mixed/stale | Ignore |
| Agno | Apache-2.0 | Py | Agents/Teams/Workflows + AgentOS | MCP | Very active, 43k | Borrow AgentOS idea |
| Vercel AI SDK / WDK | Apache-2.0 | TS | Loop agent + durable workflow | MCP (unverified) | Very active | Adapter (provider/loop, durability) |
| Temporal | MIT | Go server; Py/TS/... SDKs | Durable workflow | - | Very active | Adapter (durability port) |
| DBOS | MIT | Py, TS | Library durable | - | Active | Adapter (embedded durability) |
| Restate | **BUSL-1.1 server**, MIT SDK | multi | Durable | - | Active | Optional; license flag |
| Inngest | **SSPL + future Apache** | multi | Durable | - | Active | Avoid |
| Hatchet | MIT | Py, TS, Go, Ruby | Durable tasks | - | Active | Alternative |
| Agent Spec | Apache-2.0 OR UPL-1.0 | Py SDK | Declarative | adapters LangGraph/CrewAI/AutoGen | Active, small | Track |
| OASF | Apache-2.0 | schema | Capability records | maps to A2A cards | Small | Borrow taxonomy |
| cagent | Apache-2.0 | Go | YAML teams | MCP | Active | Borrow OCI packaging |

---

## Cross-cutting conclusions

1. Adapter candidates for a Topology/Orchestrator port (OSI + TS-friendly): Google ADK-TS, OpenAI Agents JS, Strands TS, LangGraph.js, Mastra (core only), Vercel AI SDK. Python/.NET stacks (CrewAI, MAF, ADK-py, Pydantic AI) enter as remote agents via A2A (or OpenAI-compatible HTTP), not as topology engines.
2. Recurring patterns: (a) agent loop + tools; (b) handoff = transfer of control vs agent-as-tool = call-and-return; (c) workflow agents Sequential/Parallel/Loop; (d) manager/supervisor delegating to sub-agents (Magentic, Mastra subagents, CrewAI hierarchical); (e) graph + checkpoint + interrupt/resume (LangGraph, MAF, ADK 2.0); (f) event-driven steps (CrewAI Flows, LlamaIndex); (g) durability by outsourcing to Temporal/DBOS/Restate; (h) A2A as the cross-stack wire contract, MCP for tools.
3. Own-it territory (nobody provides it well): cross-agent **deadline** propagation (only per-agent timeouts: CrewAI `max_execution_time`, Strands 900s/300s, none across A2A); **budget** propagation (Pydantic AI `usage=ctx.usage` in-process only and breaks in Temporal; Mastra `maxSteps` can only be narrowed; others report not enforce); **hop/depth/recursion limits across processes** (all limits are per-engine: LangGraph recursion_limit, ADK max_llm_calls 500, CrewAI max_iter/max_turns, Strands max_handoffs, OpenAI max_turns); **delegated identity chains** (A2A has auth schemes and AUTH_REQUIRED hand-up but no actor/on-behalf-of chain; LangGraph custom auth, OpenAI none, CrewAI per-hop client auth); **cross-agent fault attribution** (which hop failed, retry vs fail-fast; only CrewAI `fail_fast`, Mastra `hookErrorStrategy`/`bail()`, A2A error codes; no trace-context requirement in A2A); end-to-end trace correlation across stacks (OTel in MAF/Strands; OpenAI uses its own trace format).
4. License traps: LangGraph Server (Elastic-2.0 + key), Mastra `ee/`, Restate server (BUSL), Inngest (SSPL), AutoGen docs CC-BY-4.0, MCP/A2A fine (Apache-2.0). Check `inngest-js` GPL-3.0 flag if ever considered.
5. Spec formats are immature/Python-leaning (Agent Spec, OASF, cagent); A2A Agent Card + OASF skills is the only real discovery standard; a neutral topology spec has no incumbent to adopt.

## Items unverified (explicitly)

OpenAI SDK default `max_turns` value; ADK LoopAgent default/`max_iterations`, ADK OTel, ADK Resume Agents; LangGraph OTel/LangSmith specifics and MCP endpoint on Agent Server; Pydantic AI A2A/OTel; CrewAI native OTel and MCP; Vercel AI SDK subagents/MCP/telemetry/stopWhen default; Mastra A2A; AG2 v1 A2A/MCP/OTel; MAF cross-agent budget and identity; Agent Spec multi-agent components/A2A and versioning scheme; OASF governance body; Semantic Kernel maintenance-mode status (secondhand); inngest-js actual license; Letta current multi-agent API.

## Sources

- https://github.com/langchain-ai/langgraph , https://github.com/langchain-ai/langgraphjs , https://github.com/langchain-ai/agent-protocol , https://pypi.org/pypi/langgraph-api/json
- https://docs.langchain.com/oss/python/langgraph/graph-api , .../interrupts , https://docs.langchain.com/langsmith/deployment , .../server-a2a , .../custom-auth
- https://forum.langchain.com/t/question-about-the-license/2242 (secondhand)
- https://github.com/crewAIInc/crewAI , https://docs.crewai.com/en/concepts/agents , .../concepts/flows , .../learn/a2a-agent-delegation , .../observability/overview
- https://github.com/ag2ai/ag2 , https://github.com/microsoft/autogen , https://github.com/microsoft/agent-framework , https://learn.microsoft.com/en-us/agent-framework/overview/ , .../workflows/orchestrations/ , https://techcommunity.microsoft.com/blog/azuredevcommunityblog/the-future-of-agentic-ai-inside-microsoft-agent-framework-1-0/4510698
- https://github.com/google/adk-python , adk-js , adk-go , adk-java ; https://adk.dev/ , https://adk.dev/a2a/ , https://adk.dev/workflows/ , https://adk.dev/runtime/runconfig/
- https://github.com/openai/openai-agents-python , https://github.com/openai/openai-agents-js , https://openai.github.io/openai-agents-python/handoffs/ , .../running_agents/ , .../tracing/ , .../guardrails/
- https://github.com/mastra-ai/mastra (LICENSE.md) , https://mastra.ai/docs/agents/supervisor-agents
- https://github.com/strands-agents/harness-sdk , https://strandsagents.com/1.5.x/documentation/docs/user-guide/concepts/multi-agent/swarm
- https://github.com/pydantic/pydantic-ai , https://pydantic.dev/docs/ai/guides/multi-agent-applications/ , https://pydantic.dev/docs/ai/integrations/durable_execution/overview/
- https://github.com/run-llama/workflows-py , https://github.com/i-am-bee/beeai-framework , https://github.com/dapr/dapr-agents , https://github.com/kagent-dev/kagent , https://github.com/letta-ai/letta , https://github.com/camel-ai/camel , https://github.com/kyegomez/swarms , https://github.com/agno-agi/agno , https://github.com/VoltAgent/voltagent
- https://github.com/vercel/ai , https://github.com/vercel/workflow , https://ai-sdk.dev/docs/agents/overview
- https://github.com/temporalio/temporal , https://docs.temporal.io/ai-cookbook , https://github.com/restatedev/restate (LICENSE BUSL-1.1) , https://github.com/inngest/inngest (LICENSE.md SSPL) , https://github.com/dbos-inc/dbos-transact-py , https://github.com/hatchet-dev/hatchet
- https://github.com/oracle/agent-spec , https://github.com/agntcy/oasf , https://github.com/agntcy/dir , https://github.com/docker/cagent
- https://github.com/a2aproject/A2A , https://a2a-protocol.org/latest/specification/ , https://github.com/modelcontextprotocol/modelcontextprotocol
