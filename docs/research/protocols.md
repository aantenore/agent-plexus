# Research: protocols and prior art for an agent orchestration layer

Research date: 2026-11-01. Method: spec pages, GitHub raw/API, IETF datatracker API, web search. "unverified" = only secondary sources or not re-checked. Items from memory are marked "(not re-checked)".

---------------------------------------------------------------------

## A. A2A ecosystem

### Spec and governance
- Latest spec: **1.0.0** (2026-03-12, many breaking changes); latest patch **v1.0.1** (2026-05-28: HTTP binding media type `application/a2a+json`, error transcoding fixes). Prior: 0.3.0 (2025-07-30), 0.2.6, 0.2.5. Only Major.Minor negotiated (`A2A-Version` header; empty header = 0.3). Source: github.com/a2aproject/A2A/releases, a2a-protocol.org/latest/specification/
- License Apache-2.0. Repo ~26k stars, active (push 2026-11-01).
- Governance: donated by Google to Linux Foundation 2025-06-23 (founders AWS, Cisco, Google, Microsoft, Salesforce, SAP, ServiceNow); Technical Steering Committee (AWS, Cisco, Google, IBM Research, Microsoft, Salesforce, SAP, ServiceNow). **2026-08: A2A joins the Agentic AI Foundation (AAIF, Linux Foundation; AAIF launched 2025-12-09 with MCP, goose, AGENTS.md).** a2a-protocol.org banner cites a blog dated 2026-08-27; Latent Space wiki says announced 2026-08-17 (date discrepancy; exact terms unverified, no primary AAIF page fetched).
- v1.0 notable changes: multi-tenancy (`tenant` field, per-interface), `ListTasks` (cursor pagination), AgentCard `signatures`, per-interface `protocolVersion`, OAuth implicit/password flows removed (device code + PKCE flag added), mTLS scheme, enums SCREAMING_SNAKE (`TASK_STATE_COMPLETED`), methods renamed (`SendMessage`, `GetTask`, `CancelTask`), unified `Part`, `kind` discriminator removed, errors via `google.rpc.Status`, ISO-8601 UTC ms timestamps, `returnImmediately`.
- Bindings: JSON-RPC, gRPC, HTTP+JSON, or custom URI.

### AgentCard fields (spec 4.4, v1.0)
- Required: `name`, `description`, `supportedInterfaces[]` (ordered, first preferred; each `url`, `protocolBinding`, `protocolVersion`, optional `tenant`), `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills[]`.
- Optional: `provider{organization,url}`, `documentationUrl`, `securitySchemes`, `securityRequirements`, `signatures[]`, `iconUrl`.
- `AgentSkill`: required `id`, `name`, `description`, `tags`; optional `examples`, `inputModes`, `outputModes`, `securityRequirements`. Skills are free-text + tags: **no structured capability taxonomy, no cost/latency/SLA fields**.
- `capabilities`: `streaming`, `pushNotifications`, `extensions[]`, `extendedAgentCard` (authenticated richer card; selective disclosure).
- `securitySchemes`: API key, HTTP, OAuth2 (auth code + PKCE, client credentials, device code), OpenID Connect, mTLS.
- **Card signing (8.4)**: JWS (RFC 7515) over RFC 8785 JCS canonical card (excluding `signatures`). `AgentCardSignature{protected(required; must include alg,kid; typ "JOSE"; may jku), signature, header}`. Clients SHOULD verify at least one; key via `kid`/`jku` or trusted key store, HTTPS; multiple signatures allowed for rotation. Spec has an internal ambiguity on default-value stripping (flagged by fetch; unverified in practice).
- Discovery (8.2): `/.well-known/agent-card.json` (RFC 8615), curated registries, direct config. Card caching rules in 8.6.

### Extensions mechanism
- Declared in `capabilities.extensions[]` (`uri`, `description`, `required`, `params`). Client opts in via `A2A-Extensions` header; `Message.extensions[]` / `Artifact.extensions[]` list URIs present; custom data lives in `metadata` keyed by extension URI. Extensions cannot change core structures or add enum values. URIs SHOULD be versioned; breaking change = new URI. Unsupported required extension -> `ExtensionSupportRequiredError` (-32008).
- Documented example extensions (a2a-protocol.org/latest/topics/extensions/): Secure Passport, Timestamp, Traceability (Python impl), Agent Gateway Protocol (AGP; routes intents by capability). **No official extension for deadline, budget, hop count or delegation chain** (searched; none found).
- **AP2 (Agent Payments Protocol)**: A2A extension, URI `https://github.com/google-agentic-commerce/ap2/tree/v0.1`; signed Intent/Cart/Payment mandates; still v0.1 line; standardization reportedly moving to FIDO Alliance (secondary, unverified). Launch date sources conflict (Sept 2025 vs 2026). Not listed on the A2A extensions page.
- OTel has a **GenAI A2A semconv** (see E): `a2a.method.name`, `a2a.task.id`, `a2a.task.state`, `a2a.tenant`, `gen_ai.conversation.id` = A2A `contextId`.

### Official SDKs (all Apache-2.0, all under github.com/a2aproject)
| SDK | Latest release seen | Date |
|---|---|---|
| a2a-python | v1.3.0 | 2026-10-27 |
| a2a-js (TS) | v1.3.0 | 2026-09-29 |
| a2a-java | v1.4.0.Final | 2026-09-28 |
| a2a-go | v2.7.0 | 2026-10-21 |
| a2a-dotnet | only tags `v1.0.0-preview1..3` seen (no GA release via API; unverified) | - |
| a2a-rs (Rust) | cli tag a2a-cli-v0.4.5 | 2026-10-18 |
| a2a-cli | v0.3.1 | 2026-10-16 |

### Registries / directories
- **A2A itself: no registry API.** Docs: "does not prescribe a standard API for curated registries". Discussion #741 "Agent Registry - Proposal" (opened 2025-06-10 by maintainer; Catalog/Entitlements/Open discovery; `GET /agents/public`, `GET /agents/entitled`, `POST /agents/search`) is **Closed with no merged spec**; 2026 comments mention "Core + Extensions" split and a Core RFC PR (details unverified). Issue #1295 proposes separate `a2a-registry` repo (status unverified).
- **AI Catalog** (github.com/Agent-Card/ai-catalog; spec site ai-catalog.io): cross-protocol catalog at `/.well-known/ai-catalog.json`; entries = media type + URL or inline (A2A cards, MCP servers, plugins, datasets, nested catalogs); optional Trust Manifests, `did:web` identity profile. "Temporary working repo maintained by the Linux Foundation"; no release/version; license not stated; A2A and MCP steering committees would vote on adoption. Early (anecdotal: no contributor serves one yet). Possibly aliased "ARD / Agentic Resource Discovery" (secondary; Google/May 2026 claim unverified).
- **IETF DAWN WG** ("Discovery of Agents With Names", datatracker group `dawn`, active, Internet Area; chairs Dapeng Liu, Frank Brockners; AD Eric Vyncke). Scope: minimal public info about an AI resource (type, reachability, protocol) in local net / org / between trusting parties; **out of scope: capability catalogs, search/ranking, identity management**. Milestones: Jun 2027 use-cases+terminology, Dec 2027 protocol (Standards Track), Jan 2028 architecture. Many individual drafts (e.g. draft-zhang-dawn-agent-discovery-framework-09, draft-jakab-dawn-agent-discovery-mdns-01).
- **AGNTCY (Linux Foundation, "a Series of LF Projects")**: Agent Directory Service (github.com/agntcy/dir, Apache-2.0, **v1.8.0 2026-10-15**, ~200 stars; Go, gRPC/protobuf). Distributed directory, DHT content-routing mapping skills->record IDs, records modeled with **OASF** (github.com/agntcy/oasf, Apache-2.0, **v1.1.0 2026-07-10**; schema inspired by OCSF; skills, domains, modules, locators); signing/provenance, OIDC auth, federation testbed, public network ads.outshift.io. OASF can carry A2A card / MCP data via converters (Directory MCP server). An IETF draft of ADS is referenced as active (not located).
- **MCP Registry (official)**: github.com/modelcontextprotocol/registry, **v1.8.7 (2026-10-30)**, Go + PostgreSQL, registry.modelcontextprotocol.io. API v0.1 frozen 2025-10-24; docs still say "preview"; GA/v1 not confirmed. `server.json` schema; "subregistries"/aggregators implement the same OpenAPI plus `_meta`. License: repo LICENSE says MIT->Apache-2.0 transition (new contributions Apache-2.0); GitHub reports NOASSERTION. Registers **MCP servers, not A2A agents**.
- **NANDA (MIT Media Lab)**: NANDA Index (lean resolver) + signed "AgentFacts" records; research pilot, claimed ~15 institutions / 1000+ agents (single secondary source, unverified). Papers: arXiv 2508.03095 (registry survey), 2508.03101. No primary project page fetched; `projectnanda/registry` GitHub repo returned 404. Treat as research, not production.
- **Microsoft**: Entra Agent ID (agent identities, blueprints, agent users; docs say "available for all Entra customers", doc updated 2026-06-15; GA ~2026-04-30/05-01 per secondary sources). **Agent Registry moved from Entra to Microsoft Agent 365** (GA 2026-05-01, per-user licensing; registry sync to AWS Bedrock/Google Gemini Enterprise in public preview). Registry presence != Entra identity. Proprietary.
- **Google Cloud Agent Registry**: supports A2A card v0.3 and v1.0 (secondary). Proprietary.
- **Open-source A2A registries (small/community)**: A2AReg/a2a-registry (Apache-2.0, claims to follow the #741 proposal, federation + semantic search; maturity unverified), oo-a2a-registry (PyPI 0.1.0, `GET /.well-known/agents`), Apicurio Registry (Apache-2.0; 3.x exposes itself as an A2A agent via `a2a` config; whether it stores third-party cards unverified), AgentScope Runtime (Nacos-based registration).
- **agentgateway** (github.com/agentgateway/agentgateway; Apache-2.0; Linux Foundation; reported as 4th AAIF project 2026-06-04, secondary): proxy for LLM, MCP federation and A2A; JWT/OAuth/RBAC (CEL), rate limiting. No documented OBO/token exchange. Candidate data-plane for routing.

### What A2A says about multi-hop, context, chaining, timeouts
- `contextId` groups tasks/messages; server may generate or accept client value; `taskId` server-generated only; conflicting task/context -> reject. `Message.referenceTaskIds` (SHOULD be used to reference related tasks) = the only task-chaining primitive. Multi-turn via `input-required` + same taskId/contextId.
- **Delegation (7.6.2)**: a client agent can pass an authorization request up by moving its own task to `TASK_STATE_AUTH_REQUIRED`, forming a chain of tasks. **7.6.3 warns** in-band credential exchange across chains exposes credentials to each agent.
- **No timeout/deadline semantics.** Only: push-notification webhook timeout 10-30 s (SHOULD), `returnImmediately`, states COMPLETED/FAILED/CANCELED/REJECTED/INPUT_REQUIRED/AUTH_REQUIRED, `CancelTask`. **No hop limit, no deadline, no budget, no loop detection, no standard delegated-identity field.** "Opaque execution" principle: agents do not share internal state.
- Push security (13.2): SSRF validation of webhook URLs, per-config token, idempotent receipt. 13.1: authorize every operation, scope results to caller.

---------------------------------------------------------------------

## B. MCP-based agent composition

- **Current spec: 2026-07-28** (released 2026-07-28; prior 2025-11-25). Moved to **stateless**: no `initialize` handshake, no `Mcp-Session-Id`, per-request `_meta` carrying `io.modelcontextprotocol/protocolVersion` + `clientCapabilities`; new `server/discover` RPC; `subscriptions/listen` replaces GET stream and resource subscribe; SSE resumability removed; `ttlMs`/`cacheScope` on list/read results; error code range -32020..-32099 reserved for MCP.
- **Tasks** moved out of core into official extension `io.modelcontextprotocol/tasks` (repo modelcontextprotocol/ext-tasks): server may return `CreateTaskResult` (`resultType:"task"`, `taskId`, `ttlMs`, `pollIntervalMs`); `tasks/get`, `tasks/update` (client input), `tasks/cancel` (cooperative), no `tasks/list`; states working / input_required / completed / failed / cancelled; notifications via `subscriptions/listen`. Durable handle survives disconnect.
- **Elicitation** stays (client feature); **Multi Round-Trip Requests (MRTR)** replace server-initiated requests: server returns `resultType:"input_required"` with `inputRequests` (`sampling/createMessage`, `elicitation/create`, `roots/list`), client retries with `inputResponses`; `requestState` for server correlation.
- **Sampling, Roots, Logging are DEPRECATED** in 2026-07-28 (SEP-2577; min 12-month deprecation window). Migration advice: call LLM providers directly, use OTel. => do not build an "MCP server delegates to client LLM via sampling" pattern.
- **OTel trace context in `_meta`**: `traceparent`, `tracestate`, `baggage` documented (SEP-414). Only spec-level propagation hook; no deadline/budget/hop keys.
- Extensions framework (`extensions` in capabilities): Tasks, Skills over MCP, MCP Apps; auth extensions (modelcontextprotocol/ext-auth): **Enterprise-Managed Authorization** and **OAuth Client Credentials**, both Stable, revision 2026-07-28 (ID-JAG not named on that page).
- **Agents as MCP tools/servers**: no normative pattern in spec; de-facto = wrap an agent as a tool (`tools/call`) and use Tasks for long runs + MRTR for input. Loses A2A semantics (contextId, artifacts, streaming states, agent card, skill-level discovery).
- **Authorization (HTTP transports)**: optional; MCP server = OAuth 2.1 resource server (cites draft-ietf-oauth-v2-1-13; datatracker now at rev 17), client = OAuth client. MUST: RFC 9728 Protected Resource Metadata (`WWW-Authenticate` `resource_metadata`), RFC 8414 or OIDC discovery, PKCE, **RFC 8707 `resource` param in both authorize and token requests, canonical server URI**, RFC 9207 `iss` validation (new), Client ID Metadata Documents preferred over Dynamic Client Registration (DCR now deprecated), tokens only in `Authorization` header, step-up via `insufficient_scope`.
- **Token passthrough prohibited**: server "MUST NOT accept or transit any other tokens"; MUST validate audience = itself. Confused-deputy section: proxy servers need per-client consent. State-handle hijacking section: handles are not auth; bind to verified principal.
- **Multi-hop implication**: MCP core gives **no mechanism for a server that is itself a client to call a downstream resource on behalf of the user** other than obtaining a separate token for the downstream audience (RFC 8693 token exchange / ID-JAG / enterprise-managed authorization are outside core). Forwarding the inbound token is explicitly forbidden. So each hop must exchange (RFC 8693, `audience`/`resource` = next hop) and the layer must carry deadline/budget/hop out-of-band (headers or `_meta`), not in the token.

---------------------------------------------------------------------

## C. Delegation identity

### RFC 8693 semantics (verified, rfc-editor.org/rfc/rfc8693)
- Delegation = actor keeps own identity and acts for subject; impersonation = actor is indistinguishable from subject.
- `act` claim (4.1): **outermost `act` = current actor; nested `act` = prior actors**, least recent most deeply nested. Prior actors are **informational only**; access decisions consider top-level claims + current actor only. Claims like exp/nbf/aud inside `act` are not meaningful.
- `may_act` (4.4): statement that a party is authorized to become the actor; checked by the AS at exchange.
- Implication: RFC 8693 gives audit trail, **not enforcement of attenuation or depth**.

### Standards / drafts table (datatracker state resolved via API 2026-11-01)
| Name | Status | Date | Relevance |
|---|---|---|---|
| RFC 8693 OAuth Token Exchange | RFC (Proposed Standard) | 2020 (not re-checked) | OBO exchange; `act`, `may_act` |
| RFC 8707 Resource Indicators / RFC 9728 PRM / RFC 9207 iss | RFCs | - | audience binding, discovery (MCP requires) |
| RFC 9449 DPoP / RFC 8705 mTLS / RFC 9068 JWT AT / RFC 9396 RAR | RFCs | - | sender-constraint, token profile, rich authz details |
| draft-ietf-oauth-identity-chaining-17 (Identity and Authorization Chaining Across Domains) | **RFC Editor queue** (approved, being published) | rev 17, 2026-08-21 | cross-domain exchange (8693 + JWT bearer grant) |
| draft-ietf-oauth-transaction-tokens-11 | OAuth WG; WG consensus, waiting for write-up | rev 11, 2026-07-30 | call-chain context inside ONE trust domain: `txn`, `sub`, `scope`, `req_wl`, `tctx`, `rctx`, short-lived; **no `act`/actor, no delegation chain modeled**; cross-domain -> identity chaining |
| draft-ietf-oauth-identity-assertion-authz-grant-06 (ID-JAG) | WG document | rev 06, 2026-10-31 | enterprise IdP-mediated authz grant; likely basis of MCP enterprise-managed authorization (link unverified) |
| draft-ietf-oauth-v2-1-17 | WG document | 2026-10-31 | MCP's base |
| draft-ietf-oauth-client-id-metadata-document-02 | WG document | 2026-07-06 | MCP client registration |
| draft-ietf-oauth-attestation-based-client-auth-12 | WG consensus, waiting for write-up | 2026-10-18 | client attestation |
| draft-ietf-wimse-arch-08 | WG document | 2026-07-06 | workload identity architecture |
| draft-ietf-wimse-s2s-protocol-07 | **Replaced** by draft-ietf-wimse-workload-creds (-03, WG doc, 2026-10-30) and draft-ietf-wimse-http-signature-08 (Publication Requested, 2026-10-28) | - | workload-to-workload authn (WIT + HTTP message signatures) |
| draft-ietf-wimse-workload-identity-practices-08 | In IETF Last Call | 2026-10-30 | practices / BCP-style |
| draft-ietf-wimse-aims-00 | WG document | 2026-09-15 | title not fetched; scope unverified |
| draft-oauth-ai-agents-on-behalf-of-user-02 | **Expired** individual draft | 2026-02-27 | "OBO user authorization for AI agents" (content not re-read) |
| draft-asor-wimse-agent-delegation-chain-03 (-01 read) | Individual I-D, Active, **not WG adopted** | -03 2026-10-28 | offline-verifiable attenuating delegation JWT chain: `del_depth`, `del_max_depth` (non-increasable, suggested 5), `par_hash` (anti-splice), RFC 9396 `agent_delegation` + constraints, child `exp` <= parent; **no TTL claim beyond exp, no cumulative budget, no fan-out limit**; DPoP `cnf`. Single-vendor author (Attenu). Page says "WIMSE workgroup" but it is an individual submission |
| draft-niyikiza-oauth-attenuating-agent-tokens-02 | Individual I-D | 2026-10-27 | signed task-scoped attenuating credentials, offline chain verification |
| draft-liu-oauth-chain-delegation-00 | Individual I-D | 2026-06-08 | `delegation_chain` claim alongside `act`, AS-signed records (secondary: co-author Parecki) |
| draft-mw-spice-actor-chain-05 | Individual I-D, **Replaced** | 2026-04-25 | tamper-evident `actor_chain` claim |
| draft-mishra-oauth-agent-grants-02 | Individual I-D | 2026-08-30 | profile using plain `act` + 8693 attenuation, no new claims |
| draft-hamr-oauth-agent-delegation-03; draft-chen-oauth-agent-intent-token-00; draft-hulea-wimse-agent-mandate-01; draft-sweeney-wimse-credential-delegation-00 | Individual I-Ds | 2026-07..10 | variants; one reports an 8693 splice risk via compromised intermediary (secondary) |
| ~350 other individual `*agent*` drafts (datatracker name search) | Individual, none adopted | 2026 | landscape fragmented; **no WG-adopted agent delegation standard** |

- Takeaway: build now on **RFC 8693 + RFC 8707 + RFC 9449 (DPoP)**; use transaction tokens as intra-domain call-context carrier (likely to become RFC); identity chaining for cross-domain; keep any agent-specific delegation claim behind an interface (drafts will churn).
- SPIFFE (CNCF graduated, memory) / WIMSE: SVIDs give workload identity per hop; WIMSE WIT + HTTP message signatures is the IETF track; none carry deadline/budget.

---------------------------------------------------------------------

## D. Deadline / budget / hop propagation prior art

| Mechanism | Facts (verified unless noted) | Lesson |
|---|---|---|
| gRPC `grpc-timeout` | HTTP/2 header, `TimeoutValue` (max 8 ASCII digits) + unit H/M/S/m/u/n; sent as **remaining time**, not absolute (avoids clock skew); absent = infinite; Java/Go propagate by default, C++ explicit; server cancels on expiry, cancellation cascades | Propagate remaining duration, recompute each hop; always set one at the root |
| Envoy | `x-envoy-expected-rq-timeout-ms` (hint to upstream of expected duration, from `x-envoy-upstream-rq-timeout-ms` or route timeout); `x-envoy-upstream-rq-timeout-ms` override; grpc-timeout honored only with `max_grpc_timeout`; route timeout covers all retries | Retries must consume the same deadline |
| W3C Trace Context | `traceparent`/`tracestate`; Level 1 Recommendation 2021-11-23 (not re-checked); Level 2 = Candidate Recommendation Draft 2024-03-28 (random trace-id flag); tracestate max 32 members, >=512 chars propagated; MUST NOT hold PII; sampled-flag abuse (overload, collisions) -> restart traces at trust boundaries, rate-limit | Correlation only |
| W3C Baggage | Candidate Recommendation Snapshot 2024-05-30 (latest on api.w3.org); propagate if <=64 members and <=8192 bytes; grammar cap 180 members; may leak to third parties; "MUST assess the risk of header abuse"; no semantics for keys | Do NOT put authority-bearing values (budget, identity) in baggage; strip at trust boundary |
| HTTP `Max-Forwards` | RFC 9110 7.6.2: decremented per hop, meaningful only for TRACE/OPTIONS; `Via` (7.6.3) used for loop detection (not re-checked) | Hop counter + path precedent |
| SIP `Max-Forwards` | RFC 3261, default 70, 483 Too Many Hops (memory, not re-fetched) | Mandatory hop limit with a distinct error code |
| MCP | only `_meta` `traceparent`/`tracestate`/`baggage`; tasks have `ttlMs`; cooperative cancel; **no deadline/budget** | gap |
| A2A | none (see A) | gap |
| OpenAI Agents SDK | `max_turns` (LLM-call loop count) raises `MaxTurnsExceeded`; `error_handlers["max_turns"]` can return controlled output; `ModelSettings.timeout`, tool `timeout`; **no token/cost budget documented** | local bound, not cross-hop |
| LangGraph | `recursion_limit` config = max supersteps, `GraphRecursionError`; main-branch source default via env `LANGGRAPH_DEFAULT_RECURSION_LIMIT` = 10007 (older docs 25; current released default unverified) | local bound |
| Agent-delegation drafts | `del_depth`/`del_max_depth` (asor draft); child `exp` <= parent `exp` | only signed hop-limit prior art; no budget |
| Gravitee A2A quota article (secondary) | parent budget subdivided into child budgets; recursion + fan-out limits | design pattern, not a standard |

- Net: **no standard carries deadline + budget + hop limit + path for agents.** Must be owned. Constraints learned: propagate *remaining* values; monotonic non-increasing; enforced by callee and caller; keep out of baggage; cover retries/fan-out; reject with typed error (analog SIP 483 / gRPC DEADLINE_EXCEEDED); record path for loop detection (Via-like).

---------------------------------------------------------------------

## E. Multi-agent evaluation and fault attribution

### Research
- **Who&When** (Zhang et al., "Which Agent Causes Task Failures and When?", arXiv 2505.00212, ICML 2025 spotlight). Dataset 184 failure logs (126 algorithm-generated + 58 hand-crafted; fields `mistake_agent`, `mistake_step`, `mistake_reason`; GAIA / AssistantBench; 127 MAS). Methods: All-at-Once, Step-by-Step, Binary Search. Best: **53.5% agent-level, 14.2% step-level**; some below random. Code github.com/ag2ai/Agents_Failure_Attribution (MIT). HF dataset Kevin355/Who_and_When (license not stated on page).
- **MAST** (Cemri et al., "Why Do Multi-Agent LLM Systems Fail?", arXiv 2503.13657; v3 2025-10-26; NeurIPS 2025 listing). **14 failure modes in 3 categories**: system design/specification issues, inter-agent misalignment, task verification/termination. MAST-Data: 1600+ annotated traces over 7 MAS frameworks; kappa 0.88; LLM-as-judge annotator released. Individual mode names not retrieved. Repo `multi-agent-systems-failure-taxonomy/MAST` has no LICENSE at root (unverified).
- **Follow-ups (2025-2026)**: AgenTracer (arXiv 2509.03312, ICLR 2026) - counterfactual replay + programmatic fault injection to build training data; 8B model beats larger general-purpose models on Who&When by up to 18.18%; frontier reasoning LLMs <10% step-level. GraphTracer (arXiv 2510.10581). TraceElephant (ACL 2026; full traces improve attribution up to 76% vs output-only; secondary). MP-Bench (argues single-root-cause design depresses scores; secondary). TelemetrySuffBench (arXiv 2608.07899: is agent telemetry sufficient for failure-origin diagnosis?). Causal-graph attribution arXiv 2602.23701 and "Abduct, act, predict" 2509.10401 (titles only; content unverified). Survey arXiv 2605.14892.
- Takeaways: step-level LLM-judge attribution is weak; **structured traces + counterfactual replay/fault injection beat log-reading**; target agent-level first.

### OpenTelemetry GenAI semantic conventions
- Moved to **open-telemetry/semantic-conventions-genai** (old page says no longer maintained). All status **Development** (not stable). Signals: client inference, embeddings, events, exceptions, metrics, model spans, **agent spans**, MCP (`mcp.*`), A2A (`a2a.*`), provider-specific conventions. Schema URL still "TODO".
- Agent spans: `create_agent {name}` and `invoke_agent {name}` (CLIENT kind), `invoke_workflow`; attributes `gen_ai.operation.name`, `gen_ai.agent.id|name|description|version`, `gen_ai.conversation.id`. `gen_ai.agent.id` may be a provider ARN/registry id. A2A spans: name = `{a2a.method.name}`, A2A instrumentation SHOULD NOT emit higher-level agent spans. Gap: **no attribute for delegating agent, hop index, budget consumed, or fault verdict** (own namespace needed).

### Open-source trace/eval tools (license from LICENSE files, 2026-11-01)
| Tool | License | Notes |
|---|---|---|
| Langfuse | MIT core; `ee/` dirs under separate commercial license; copyright line "ClickHouse, Inc." (ownership change unverified) | OTel ingest, trace/agent graph, LLM-judge evals, datasets |
| Arize Phoenix | **Elastic License 2.0** (source-available, not OSI open source; no managed-service resale) | OTel/OpenInference, evals |
| OpenLLMetry (Traceloop) | Apache-2.0 | OTel instrumentation for LLM stacks |
| DeepEval | Apache-2.0 | metrics incl. agent/tool metrics; commercial Confident AI platform |
| promptfoo | MIT | CLI eval/red-team, CI-friendly |
| Inspect AI (UK AISI) | MIT | eval framework, agent/sandbox support, logs |
| Who&When code | MIT | reference attribution judges |
| LangGraph / OpenAI Agents SDK | MIT / MIT | runtimes; local step bounds only |
- None found that attributes faults across A2A/MCP hops natively; all rely on instrumentation spans. System-level eval + cross-agent attribution is an owned component (trace schema + replay/fault-injection harness + judge).

---------------------------------------------------------------------

## Source URLs
- A2A: https://a2a-protocol.org/latest/specification/ ; https://github.com/a2aproject/A2A/releases ; https://a2a-protocol.org/latest/topics/agent-discovery/ ; https://a2a-protocol.org/latest/topics/extensions/ ; https://a2a-protocol.org/latest/whats-new-v1/ ; https://github.com/a2aproject/A2A/discussions/741 ; https://linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents ; https://latent.space/wiki/aaif/
- SDKs: https://github.com/a2aproject/a2a-python , a2a-js , a2a-java , a2a-dotnet , a2a-go , a2a-rs , a2a-cli
- Registries: https://github.com/Agent-Card/ai-catalog ; https://datatracker.ietf.org/wg/dawn/about/ ; https://github.com/agntcy/dir ; https://github.com/agntcy/oasf ; https://dir.agntcy.org/latest/dir/dir-overview/ ; https://github.com/modelcontextprotocol/registry ; https://modelcontextprotocol.io/registry/registry-aggregators ; https://arxiv.org/html/2508.03095v1 ; https://learn.microsoft.com/en-us/entra/agent-id/what-are-agent-identities ; https://github.com/agentgateway/agentgateway ; https://github.com/A2AReg/a2a-registry
- MCP: https://modelcontextprotocol.io/specification/2026-07-28/ ; https://modelcontextprotocol.io/specification/latest/changelog ; https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization ; https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices ; https://modelcontextprotocol.io/extensions/tasks/overview ; https://github.com/modelcontextprotocol/ext-tasks ; https://github.com/modelcontextprotocol/ext-auth
- IETF: https://www.rfc-editor.org/rfc/rfc8693.html ; https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/ ; https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/ ; https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/ ; https://datatracker.ietf.org/doc/draft-ietf-wimse-arch/ ; https://datatracker.ietf.org/doc/draft-ietf-wimse-workload-creds/ ; https://datatracker.ietf.org/doc/draft-ietf-wimse-http-signature/ ; https://www.ietf.org/archive/id/draft-asor-wimse-agent-delegation-chain-01.html ; https://datatracker.ietf.org/doc/html/draft-niyikiza-oauth-attenuating-agent-tokens-00 ; https://www.ietf.org/archive/id/draft-liu-oauth-chain-delegation-00.html ; https://datatracker.ietf.org/doc/html/draft-mw-spice-actor-chain-00 ; https://www.ietf.org/archive/id/draft-mishra-oauth-agent-grants-02.html
- Propagation: https://grpc.io/docs/guides/deadlines/ ; https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md ; https://www.w3.org/TR/baggage/ ; https://www.w3.org/TR/trace-context-2/ ; https://www.rfc-editor.org/rfc/rfc9110 ; https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter ; https://openai.github.io/openai-agents-python/running_agents/ ; https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT
- Eval: https://arxiv.org/abs/2505.00212 ; https://github.com/ag2ai/Agents_Failure_Attribution ; https://huggingface.co/datasets/Kevin355/Who_and_When ; https://arxiv.org/abs/2503.13657 ; https://arxiv.org/abs/2509.03312 ; https://arxiv.org/abs/2510.10581 ; https://github.com/open-telemetry/semantic-conventions-genai ; https://github.com/langfuse/langfuse ; https://github.com/Arize-ai/phoenix ; https://github.com/traceloop/openllmetry ; https://github.com/confident-ai/deepeval ; https://github.com/promptfoo/promptfoo ; https://github.com/UKGovernmentBEIS/inspect_ai
