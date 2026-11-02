# @agent-plexus/adapters/rule-attribution

Maps **deterministic rules on hop records** → **AttributionPort** (layer `attribution`). Tier: prototype, production.

Names the layer and the member behind a failed run from the hop record, branching on the stop code only. Calls nothing. When
the record source reads texts, it also traces a `guard_block` past members that only repeated their input. Reasons and evidence are short identifiers (codes, hop ids, node paths), never texts.

## Rules

| # | Situation | Layer | Member | Confidence |
|---|---|---|---|---|
| 1 | The candidate is the earliest hop that did not complete, or whose member failed an expectation (a score with `member` below 1); hops the topology abandoned are skipped | | | |
| 1 | Completed hop of a member that failed an expectation | `member` | The hop | medium |
| 2 | A route node that chose no member or whose routing failed (a hop with `route` and no member) | `routing` | none | high |
| 3 | `hop_limit` | `topology`, `routing` when a router chose the call | none | high |
| 3 | `timeout`, `limit` with `reason.layer` `topology` (the system's own limit or deadline) | `topology` | none; evidence has the code and `by:<reason.by>` | high |
| 3 | `timeout`, `limit` otherwise | `member` | `limit`: the hop with the most tokens (input + output) when any hop reports usage, else the highest `costUsd`, else the longest duration; a `replayed` hop's usage and cost count for nothing (an earlier invocation spent them). `timeout`: the longest duration | medium |
| 3 | `reason.layer` is `host`: `denied`, `needs_auth` | `host` | none | high |
| 3 | `reason.layer` is `host`: `guard_block` | `host` | `stage` `receive`: the hop's own member (its output was blocked); `send` or absent: the first upstream member that added text (see Echo); none when every upstream member only repeated the caller's input (evidence `origin:input`) | high |
| 3 | `guard_block` from a member, with an earlier completed hop | `member` | The first upstream member that added text (see Echo) | medium |
| 3 | `guard_block` from a member, every upstream member only repeated the caller's input | `member` | The hop; evidence has `echo:<hopId>` and `origin:input` | high with a member layer, else medium |
| 3 | `guard_block` otherwise, `failed`, `error`, other codes | `member` | The hop | high with a member layer, else medium |
| 3 | `rejected` | `member` | The hop | low |
| 3 | `needs_input`, `needs_auth` from a member, `aborted` | none | | |
| 4 | Every hop completed and a score is below 1 | `member` | The last completed hop | low |

Other layers: `reason.layer` of `topology` on any other code gives layer `topology`.

Confidence values: high 0.9, medium 0.6, low 0.3.

## Echo

A completed member hop echoed when its input text, trimmed, is non-empty, is contained in its output text, and is at
least `echoShare` of the output's length. For a `guard_block` the walk starts at the previous completed hop. While the
hop echoed, it goes on to the hop before it if that hop's output is exactly the echoing hop's input; otherwise, or when
there is no such hop, the content came from the caller (`origin:input`). The first hop that did not echo is blamed.
Each echoed hop adds `echo:<hopId>` to the evidence. Texts are read with `RecordSource.text`; a missing reference, a
source without `text` or a failed read counts as not echoed, so the previous completed hop is blamed. Texts are
compared only, never copied into evidence.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `echoShare` | number in (0, 1] | 0.5 (`DEFAULT_ECHO_SHARE`) | Smallest share of the output that the repeated input must be for a member to count as echoing |

## Member layer

`memberLayer` is the member's own name for where it failed. When the record source has spans for the blamed hop, the
first span with status `error` or `failed` and a layer gives it; otherwise `reason.memberLayer`, else `reason.layer`
unless that is a plexus layer id or `host` (the form used before `memberLayer`; the core's `memberLayerOf` reads both).
A source that fails to deliver spans is ignored.

## Limits

None. Rule 4 and the upstream rule are approximations: the record does not say which hop's output fed which, so the
upstream hop is the previous completed hop in record order, refined by the echo walk when texts are readable. Use a judge or replay adapter for finer blame.
