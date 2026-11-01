# AttributionPort

Layer: `attribution` (L5 Attribution) · Version: 0.1.0 · Conformance: planned

## Purpose

Name the layer and the member behind a failed run, from its hop records and scores.

## Operations

- `attribute(input: AttributionInput) → [Attribution]`
  An empty list means no failure to attribute.

`AttributionInput` is `{record: [HopRecord], result: MemberResult, scores: [Score], source?: RecordSource}`.

A `RecordSource` is an interface inside this layer, not a port: `records(rootRunId) → [HopRecord]` and, when available,
`spans(hopId) → [MemberSpan]`, where `MemberSpan` is `{name, layer?, status?, attrs?}`: the member's own spans for a hop.

## Data shapes

`HopRecord`, `Score` and `Attribution` are in [the language](../language.md#hoprecord).

## Semantics

- Branch on `reason.code` only. `detail` is never parsed.
- Skip hops the topology abandoned.
- `layer` is a plexus layer id, or `host` when the host's gate refused a call. `member` names the hop's member when a
  member is to blame; a route that chose nobody, and a system limit, name none.
- `memberLayer` is the member's own name for where it failed. Read it from the member's spans when the source has them,
  else from `reason.layer` unless that is a plexus layer id or `host`.
- `evidence` holds short identifiers (codes, hop ids, node paths), never texts.
- Waiting is not a failure: `needs_input`, a member's `needs_auth` and `aborted` give no attribution.
- The core passes at most `limits.attribution.maxRecords` records, and an in-memory source of recent runs.

## Errors

An adapter that cannot decide returns an empty list. A source that fails to deliver spans is ignored.

## Escape hatch

`Attribution.evidence` carries adapter-specific facts as identifiers; there is no `ext` on `Attribution` today.

## Conformance

A `checkAttribution` suite is planned. It will verify: an empty record gives no attribution; `confidence` is in
[0, 1]; abandoned hops are skipped; the rules table of the adapter holds.

## Version history

- 0.1.0: initial. Reference adapter: [`rule-attribution`](../../adapters/rule-attribution).
