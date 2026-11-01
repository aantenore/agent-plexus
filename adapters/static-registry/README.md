# @agent-plexus/adapter-static-registry

Maps **static member list** → **RegistryPort** (layer `registry`). Tier: prototype, production.

Lists the members configured in the system, with optional overrides from config. Entries are read when asked, so the
registry always reflects the members as assembled.

Fetching and verifying agent cards from URLs is a later slice; this adapter does not fetch anything.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `entries` | object | `{}` | Member id → overrides; ids that are not members are ignored |

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

## Filters

| Filter | Matches an entry when |
|---|---|
| `skills` | any listed id is one of its skill ids |
| `tags` | every listed tag appears in some skill |
| `attrs` | every key is equal; a list on the filter means any of; a list on the entry matches if it contains the value |

An empty list is no constraint. `get(id)` returns the merged entry, or `undefined`.

## Limits

None.
