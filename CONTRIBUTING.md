# Contributing

## Add an adapter in one pull request

Adapters are independent packages, so anyone can add and maintain one without touching the core.

1. Create `adapters/<name>` from a reference adapter such as [`adapters/skill-router`](adapters/skill-router). Name it
   after the framework, protocol or technology it maps: `a2a-member`, `sqlite-execution`.
2. In `package.json`: name `@agent-plexus/adapter-<name>`, set `repository.directory` to `adapters/<name>`, keep
   `@agent-plexus/core` as a peer dependency and the `@agent-plexus/source` export condition that points at `src/`.
   Runtime dependencies only when the technology needs a client library.
3. In `src/index.ts`: a factory plus a `defineAdapter` descriptor with `fills`, `name` (= `<name>`), `maps`
   (`standard` or `technology`), `portVersion: PORT_VERSIONS.<Port>`, `tiers` and `optionsSchema`; export an `adapters`
   array. Technology-specific data goes in `ext`. Every timeout, size, count or truncation length is an option
   declared once with `defineLimits` and set as the descriptor's `limits` (see [docs/limits.md](docs/limits.md)),
   never a literal in the code.
4. Tests: `test/*.test.ts` with `node:test`. For an upstream service, add a contract test against a pinned version that
   skips when the service is down. Per-port conformance suites are planned.
5. `README.md`: what it maps onto which port, tiers, an options table, a config snippet and its limits.
6. Add the adapter to the catalog in [docs/adapters.md](docs/adapters.md) (remove it from the Planned list if it was
   there) and its limits to [docs/limits.md](docs/limits.md).

Checks for the pull request, run only for the package you touched:

```bash
npm run typecheck -w @agent-plexus/adapter-<name>
npm test -w @agent-plexus/adapter-<name>
```

New adapters start as `experimental`; the criteria for `beta` and `stable` are in
[docs/adapters.md](docs/adapters.md#maturity).

## Change the core

The core (`packages/core`, `packages/cli`) and the spec (`spec/`) are owned by the maintainers. A core change starts
with a spec change:

1. Update the port page in `spec/ports/`, or [`spec/language.md`](spec/language.md) / [`spec/hooks.md`](spec/hooks.md).
2. Bump the port version in `PORT_VERSIONS` (`packages/core/src/ports.ts`).
3. Then the core, then the adapters that declare the old version.

Documentation follows the same rule: a changed layer, port, hook, limit or CLI option must be reflected in `docs/` and
`spec/`. The core depends on nothing; keep it that way.

## Style

TypeScript, ESM, Node >= 22.18, `node --test`, small files, short JSDoc. Zero runtime dependencies in the core
packages. Documentation in English, short sentences, tables over prose, no marketing language. Never put tokens or
secrets in errors, logs or telemetry. Framework and protocol names appear only in adapter packages.

## Documentation

- Layer pages follow one pattern: question, responsibility, ports, where it sits, standards, boundaries, configuration,
  telemetry, evaluation, how to swap, reference adapters, reference setup.
- Diagrams use the palette in [docs/diagrams.md](docs/diagrams.md) and are listed in its index.
- Describe what exists as implemented. Mark scheduled work as planned and any other technology as a candidate; the
  words are defined in [docs/adapters.md](docs/adapters.md#catalog).
- Check relative links by hand; check Mermaid blocks with the command in [docs/diagrams.md](docs/diagrams.md#checking-a-diagram).
