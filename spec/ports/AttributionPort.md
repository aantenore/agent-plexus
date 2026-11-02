# AttributionPort

Layer: `attribution` (L5 Attribution) · Version: 0.1.0 · Conformance: [`checkAttribution`](../../packages/conformance) in `@agent-plexus/conformance`

## Purpose

Name the layer and the member behind a failed run, from its hop records and scores.

## Operations

- `attribute(input: AttributionInput) → [Attribution]`
  An empty list means no failure to attribute.

`AttributionInput` is `{record: [HopRecord], result: MemberResult, scores: [Score], source?: RecordSource}`.

A `RecordSource` is an interface inside this layer, not a port: `records(rootRunId) → [HopRecord]` and, when available,
`spans(hopId) → [MemberSpan]`, where `MemberSpan` is `{name, layer?, status?, attrs?}`: the member's own spans for a hop. A source may also give `text(key) → string?`, which reads a text stored in the execution journal by key (`inputRef`, `outputRef`). Adapters only compare texts and never copy them into evidence.

## Data shapes

`HopRecord`, `Score` and `Attribution` are in [the language](../language.md#hoprecord).

## Semantics

- Branch on `reason.code` only. `detail` is never parsed.
- Skip hops the topology abandoned.
- `layer` is a plexus layer id, or `host` when the host's gate refused a call. `member` names the hop's member when a
  member is to blame; a route that chose nobody, and a system limit, name none.
- `reason.layer` is read only as a plexus layer id or `host`. A member layer id that equals a plexus layer id (a
  member's own `routing`, say) would be ambiguous there, so a member puts its own layer in `reason.memberLayer`.
- `memberLayer` is the member's own name for where it failed. Read it from the member's spans when the source has them,
  else from `reason.memberLayer`, else from `reason.layer` when that is neither a plexus layer id nor `host` (the form
  used before `memberLayer`; core `memberLayerOf` reads both).
- `evidence` holds short identifiers (codes, hop ids, node paths), never texts.
- Waiting is not a failure: `needs_input`, a member's `needs_auth` and `aborted` give no attribution.
- The core passes at most `limits.attribution.maxRecords` records, and an in-memory source of recent runs.

## Errors

An adapter that cannot decide returns an empty list. A source that fails to deliver spans is ignored.

## Escape hatch

`Attribution.evidence` carries adapter-specific facts as identifiers; there is no `ext` on `Attribution` today.

## Conformance

`checkAttribution` in [`@agent-plexus/conformance`](../../packages/conformance) checks this port: rules At1-At8. Among them: an empty record gives no attribution; `confidence` is in [0, 1]; abandoned, waiting and `aborted` hops are skipped; stored texts never reach the evidence; the adapter's rules table holds. The package README lists all the rules.

## Version history

- 0.1.0: initial. Reference adapter: [`rule-attribution`](../../adapters/rule-attribution).
