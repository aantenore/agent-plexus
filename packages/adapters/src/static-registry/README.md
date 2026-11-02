# @agent-plexus/adapters/static-registry

Maps **static member list** → **RegistryPort** (layer `registry`). Tier: prototype, production.

Lists the members configured in the system, with optional overrides from config. Entries are read when asked, so the
registry always reflects the members as assembled.

Fetching and verifying agent cards from URLs is a later slice; this adapter does not fetch anything. Trust comes from
the member that fetched and verified its card (`a2a-member`, with keys from config); this adapter can refuse entries
that lack it.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `entries` | object | `{}` | Member id → overrides; ids that are not members are ignored |
| `trust` | object | none | Trust policy; entries that fail it are withheld (see below) |

Per entry:

| Field | Effect |
|---|---|
| `description` | Replaces the description |
| `skills` | Replaces the skills: `{ id, name?, description?, tags? }` |
| `tags` | Added as one more skill (id `tags`), so tag filters see them |
| `attrs` | Merged over the member's attrs |

```json
{
  "ports": {
    "registry": {
      "adapter": "static-registry",
      "options": { "entries": { "billing": { "tags": ["money"], "attrs": { "region": "eu" } } } }
    }
  }
}
```

## Trust policy

| `trust` field | Effect |
|---|---|
| `requireSigned` | Entries must carry a verified card signature (`trust.signed`) |
| `keyIds` | The signature must come from one of these key ids (`trust.keyId`); implies `requireSigned`; not empty |
| `exempt` | Member ids the policy does not apply to, for local members that have no card; ids that are not members are ignored |

An entry fails when it is not exempt and its `trust` is missing or not signed, or `keyIds` is set and its `keyId` is not
listed. `get(id)` then returns `undefined` and `list` omits it. Each refusal is reported once, until the entry changes,
as a `plexus.registry.refused` event with the member id (`plexus.member`) and the reason (`plexus.registry.reason`:
`unsigned` or `key`); the card is never included.

With the system config flag `registry.requireListed: true` (see the
[config reference](../../../../docs/guide.md#stack-config-reference)), the core treats a member the registry's `get` does not
return as not callable, even if the topology names it directly (`denied`, layer `registry`). The policy then also blocks
calls to refused members. Without the flag a registry only supplies route candidates, and a refused member can still be
named by the topology.

```json
{
  "ports": {
    "registry": {
      "adapter": "static-registry",
      "options": { "trust": { "requireSigned": true, "keyIds": ["partners-2026"], "exempt": ["triage", "billing"] } }
    }
  }
}
```

## Filters

| Filter | Matches an entry when |
|---|---|
| `skills` | any listed id is one of its skill ids |
| `tags` | every listed tag appears in some skill |
| `attrs` | every key is equal; a list on the filter means any of; a list on the entry matches if it contains the value |

An empty list is no constraint. `get(id)` returns the merged entry, or `undefined`.

## Limits

None.
