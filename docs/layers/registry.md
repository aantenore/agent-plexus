# Registry

Layer id `registry` (L1), Discovery plane. *Which agents exist, what can they do, can their cards be trusted?*

## Responsibility

List the agents of the system with what they can do, and say how far each can be trusted. The registry answers
questions about candidates; it does not choose among them ([routing](routing.md)) and does not call them
([member](member.md)).

## Ports

| Port | What it does |
|---|---|
| [RegistryPort](../../spec/ports/RegistryPort.md) | `list` entries that match a filter; `get` one entry by id |

Data shapes: `AgentEntry` and `CandidateFilter` in [spec/language.md](../../spec/language.md).

An `AgentEntry` has `id`, `name`, `description`, `skills` (`id`, `name`, `description`, `tags`), `endpoint`
(`protocol`, `url?`, `ref?`), `audience?`, `attrs?`, `trust` (`signed`, `keyId?`, `pinned`) and `version?`. A filter has
`skills`, `tags` and `attrs`; an empty list is no constraint.

### Where it sits

```mermaid
flowchart LR
  topology["L3 topology<br/>route node"]:::agent -->|"scope.route"| core["core<br/>candidates, cut at maxCandidates"]:::external
  core -->|"list, get"| rg
  subgraph sg["L1 registry"]
    rg["RegistryPort<br/>list, get"]:::model
  end
  core -->|"candidates"| routing["L2 routing"]:::model
  rg --> src["member list,<br/>agent cards (planned),<br/>directory (candidate)"]:::external
  check["check<br/>registry.requireSigned"]:::external -.-> rg
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Standards

Mapped by adapters, not by the port:

- A2A agent cards (`/.well-known/agent-card.json`): skills, security schemes, JWS signatures. `a2a-member` reads and
  verifies the card of its own member; a registry source that lists cards is planned.
- AGNTCY Agent Directory with OASF skills, and Kubernetes CRDs: candidates.

## Boundaries

- Cards are untrusted. Planned: JWS signatures checked against configured keys, size and count bounded, cached with a
  TTL. Production requires signed cards or endpoints pinned in config.
- `audience` always comes from config; a card cannot set the audience a token is minted for.
- `registry.requireSigned` makes `check` fail every member with neither a signed card nor a pinned endpoint. A
  function member is pinned.
- The core cuts the candidates it hands to a router at `limits.router.maxCandidates`.
- Choosing among candidates is [routing](routing.md); a registry does not rank.

## Configuration

```json
{
  "ports": {
    "registry": { "adapter": "static-registry", "options": { "entries": { "billing": { "tags": ["billing"] } } } }
  },
  "registry": { "requireSigned": false },
  "limits": { "registry": { "cardTtlMs": 300000, "maxCardBytes": 65536 } }
}
```

The registry slot is optional; a `route` node needs it to find candidates. Limits: [limits.md](../limits.md).

## Telemetry

The registry emits no span of its own. Candidate lookup happens inside the `plexus.route` span of
[routing](routing.md).

## Evaluation

A wrong or missing candidate shows as a route that chose no member, attributed to layer `routing`. Tags and skills in
the registry are what routing rules and evaluation cases rely on.

## How to swap

Change `ports.registry.adapter`. Members, rules and topology stay. Adapters that fetch cards read `limits.registry.*`.

## Reference adapters

| Adapter | Maps | Status |
|---|---|---|
| [`static-registry`](../../adapters/static-registry) | The members configured in the system, with overrides from config; fetches nothing (prototype, production) | implemented |
| Card-fetching registry | Cards listed in config, fetched, pinned, signatures checked | candidate |
| AGNTCY Agent Directory + OASF | Apache-2.0 | candidate |
| Kubernetes CRDs | Apache-2.0 | candidate |

Full list: [adapters.md](../adapters.md).

## Reference setup

[`examples/offline`](../../examples/offline/README.md) tags `billing` with `billing` and `manuals` with `product`.
