# @agent-plexus/adapters/function-member

Maps **in-process function** → **MemberPort** (layer `member`). Tier: prototype, production.

Wraps a function as a member. The function receives the input and the call context and returns the answer text, or a
full member result to report another status. It is the reference member: it needs no network and no agent runtime.
Declared `capabilities`: none (no `resume`, `cancel`, `checkpoint`; `waits` false). A function that returns `waiting`
is passed on, but the run cannot continue it.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `module` | string | none | `"<path>#<export>"`, the path relative to the system config directory; without `#<export>`, the default export |
| `fn` | function | none | The function itself, for tests and programmatic use; takes the place of `module` (not available in JSON config) |
| `name` | string | member id | Display name |
| `description` | string | `""` | What the member does |
| `skills` | object[] | none | `{ id, name?, description?, tags? }` |
| `tags` | string[] | none | Tags of one `default` skill, used when `skills` is not set |
| `attrs` | object | none | Attributes for registry filters |
| `audience` | string | none | Credential audience |

One of `module` or `fn` is required.

```json
{
  "members": {
    "triage": {
      "adapter": "function-member",
      "options": { "module": "./members/triage.js#answer", "description": "First line of support", "tags": ["support"] }
    }
  }
}
```

## Behaviour

| Case | Result |
|---|---|
| Function returns a string | `completed` with that output |
| Function returns a `MemberResult` | Validated: `status` must be a run status, `output` a string; otherwise the call is rejected with a `TypeError` |
| Status other than `completed` without a reason | Reason `{ code: "error" }` is added |
| Function throws | The error propagates; the core maps it |
| `ctx.signal` aborted, before or during the call | `stopped` with reason `aborted`; the function is not interrupted, its late result is dropped |

`describe()` returns the entry with endpoint `{ protocol: "function", ref: <module> }` and trust `{ signed: false,
pinned: true }`.

## Limits

None. The function is trusted code in the same process: nothing bounds its time except `ctx.signal`.
