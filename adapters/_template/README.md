# @agent-plexus/adapter-template

Maps **a fixed greeting** → **MemberPort** (layer `member`). Tier: prototype.

A copyable skeleton. To start a new adapter:

1. Copy this folder to `adapters/<name>`, where `<name>` is the standard or technology the adapter maps (`a2a-member`,
   `sqlite-execution`, ...).
2. Rename the package to `@agent-plexus/adapter-<name>`, set `repository.directory` and `homepage`, drop
   `"private": true`, and set `name` in the descriptor to `<name>`: a system config then uses it with
   `"adapter": "<name>"`.
3. Implement the port in `src/index.ts`: a factory plus a `defineAdapter` descriptor that declares `fills`, `name`,
   `maps`, `portVersion`, `tiers`, `optionsSchema` and `limits` (and `capabilities` for a MemberPort adapter).
4. Make `test/conformance.test.ts` pass with the fixtures your port needs (see
   [`@agent-plexus/conformance`](../../packages/conformance)), then add a live contract test against the pinned
   upstream version.

## What the skeleton shows

- **Limits.** `maxInputChars` is declared once in `limits` with `defineLimits`, described in the options schema and set
  as the descriptor's `limits`; the code reads the option or the limit's default. Conformance checks that every limit is
  in the schema (D2) and that options are validated as a system config would validate them (D3).
- **`capabilities`.** What the member does beyond `describe` and `invoke`: none here. Conformance checks that they
  match the instance (M9), and the readiness gate warns about a system that needs more.
- **`ext`.** The answer carries `template.chars`, a key in the adapter's namespace. Conformance checks that every key is
  namespaced (M2).
- **Problems are results.** An aborted call and an input over the limit end `stopped` with a code, never an exception.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `greeting` | string | `"Hello"` | Text put before the input in every answer |
| `description` | string | `""` | What the member does |
| `maxInputChars` | integer | `10000` | Longest input answered; a longer one ends `stopped` with code `rejected` |

```json
{ "members": { "greeter": { "adapter": "template", "options": { "greeting": "Hi" } } } }
```

## Maturity checklist

The levels are defined in [docs/adapters.md](../../docs/adapters.md#maturity). Before asking for a level:

- experimental
  - [ ] `defineAdapter` descriptor with `fills`, `name`, `maps`, `portVersion`, `tiers` and `optionsSchema`
  - [ ] every timeout, size, count or truncation length is a declared limit with a row in docs/limits.md
  - [ ] MemberPort: `capabilities` declared; `ext` keys namespaced as `<adapter>.<name>`
  - [ ] `test/conformance.test.ts` reports no failures (a known gap marked `todo` with the rule id, never removed)
  - [ ] README with what it maps, tiers, an options table, a config snippet and its limits; a row in docs/adapters.md
- beta
  - [ ] conformance passing in CI, no `todo`
  - [ ] upstream version pinned, with a live contract test that skips when the service is down
  - [ ] an owner
- stable
  - [ ] beta for at least one minor release of its port without breaking changes
  - [ ] every option documented
  - [ ] used in a reference setup
