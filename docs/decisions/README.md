# Decisions

Architecture decision records: one file per decision that shapes the contracts, the core or how adapters are
written. Same format as agent-layers: `NNNN-short-title.md`, first line `Status: Proposed | Accepted | Superseded by
NNNN · Date · Decided by`, sections Context, Decision, Consequences; an accepted record is not rewritten. Prefer
tables to prose, and add any diagram to the index in [diagrams.md](../diagrams.md).

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-own-ports-agent-layers-as-adapter.md) | Six layers between agents; control and insight from a host, agent-layers as the reference host adapter | Proposed | 2026-11-01 |

## Open decisions

Questions that are not decided yet, with the current recommendation. A decision that is taken becomes a record above.

| # | Decision | Recommendation |
|---|---|---|
| 1 | Name `agent-plexus`, scope `@agent-plexus` (confirmed only when the npm org is created). | Keep |
| 2 | Repository visibility (private now). | Private until slice 1 runs |
| 3 | The six layers, and host hooks instead of own control and insight layers. | Accept |
| 4 | Production ExecutionPort: DBOS or Temporal. | DBOS first |
| 5 | Budget across `parallel` branches: even reserved shares or a first-come pool. | Even shares |
| 6 | Own topology language; other formats only as import adapters. | Own |
| 7 | Hand the agent-layers proposal over: it defines the bounds rules and the A2A extension both projects use. | Hand it over |
| 8 | Production registry candidate: AGNTCY directory or Kubernetes CRDs. | When the first production deployment is known |
| 9 | `a2a-member` on the official A2A JS SDK, or on plain `fetch`. | The SDK |

Slice 1 has landed (core, CLI, six reference adapters, offline example): decision 2's condition is met, and decision 5 is
implemented as even shares (`parallel` branches reserve `1/branches` of the budget) pending the decision.
