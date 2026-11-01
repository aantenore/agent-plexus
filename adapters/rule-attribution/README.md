# @agent-plexus/adapter-rule-attribution

Maps **deterministic rules on hop records** → **AttributionPort** (layer `attribution`). Tier: prototype, production.

Names the layer and the member behind a failed run from the hop record, branching on the stop code only. Takes no
options and calls nothing. Reasons and evidence are short identifiers (codes, hop ids, node paths), never texts.

## Rules

| # | Situation | Layer | Member | Confidence |
|---|---|---|---|---|
| 1 | The candidate is the earliest hop that did not complete, or whose member failed an expectation (a score with `member` below 1); hops the topology abandoned are skipped | | | |
| 1 | Completed hop of a member that failed an expectation | `member` | The hop | medium |
| 2 | A route node that chose no member (a hop with `route` and no member) | `routing` | none | high |
| 3 | `hop_limit` | `topology`, `routing` when a router chose the call | none | high |
| 3 | `timeout`, `limit` with `reason.layer` `topology` (the system's own limit or deadline) | `topology` | none; evidence has the code and `by:<reason.by>` | high |
| 3 | `timeout`, `limit` otherwise | `member` | `limit`: the hop with the most tokens (input + output) when any hop reports usage, else the highest `costUsd`, else the longest duration. `timeout`: the longest duration | medium |
| 3 | `reason.layer` is `host`: `denied`, `needs_auth` | `host` | none | high |
| 3 | `reason.layer` is `host`: `guard_block` | `host` | `stage` `receive`: the hop's own member (its output was blocked); `send` or absent: the previous completed hop's member, if any (a host `guard_block` on `send` names the upstream member) | high |
| 3 | `guard_block` from a member, with an earlier completed hop | `member` | That upstream hop's member | medium |
| 3 | `guard_block` otherwise, `failed`, `error`, other codes | `member` | The hop | high with a member layer, else medium |
| 3 | `rejected` | `member` | The hop | low |
| 3 | `needs_input`, `needs_auth` from a member, `aborted` | none | | |
| 4 | Every hop completed and a score is below 1 | `member` | The last completed hop | low |

Other layers: `reason.layer` of `topology` on any other code gives layer `topology`.

Confidence values: high 0.9, medium 0.6, low 0.3.

## Member layer

`memberLayer` is the member's own name for where it failed. When the record source has spans for the blamed hop, the
first span with status `error` or `failed` and a layer gives it; otherwise `reason.layer`, unless that is a plexus
layer id or `host`. A source that fails to deliver spans is ignored.

## Limits

None. Rule 4 and the upstream rule are approximations: the record does not say which hop's output fed which, so the
upstream hop is the previous completed hop in record order. Use a judge or replay adapter for finer blame.
