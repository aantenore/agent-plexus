# Contributing

## Add an adapter in one pull request

The reference adapters live in one package, `@agent-plexus/adapters`, one subpath export each, so a release publishes
few packages. An adapter maintained outside this repository is a package of its own, used through the config's
`plugins`, and needs no change here.

1. Create `packages/adapters/src/<name>/`, named after the framework, protocol or technology it maps: `a2a-member`,
   `sqlite-execution`. [`examples/adapter-template`](examples/adapter-template) shows a descriptor, limits,
   `capabilities`, namespaced `ext`, a passing conformance test and a maturity checklist.
2. In `packages/adapters/package.json`: add the subpath `./<name>` to `exports`, with the `@agent-plexus/source`
   condition first (`./src/<name>/index.ts`), then `types` and `import` (`./dist/<name>/index.d.ts`, `.js`). A client
   library only this adapter needs is an optional peer dependency (`peerDependencies` plus `peerDependenciesMeta`) and a
   dev dependency for the tests; installing the package pulls in nothing heavy.
3. In `src/<name>/index.ts`: a factory plus a `defineAdapter` descriptor with `fills`, `name` (= `<name>`), `maps`
   (`standard` or `technology`), `portVersion: PORT_VERSIONS.<Port>`, `tiers` and `optionsSchema`; export an `adapters`
   array. A MemberPort adapter also declares `capabilities` (`resume`, `cancel`, `checkpoint`, `waits`) so the
   readiness gate can warn about systems that need more. The core checks the descriptor when it loads it
   (`checkDescriptor`) and refuses an incompatible `portVersion`. A name alone (`"adapter": "<name>"`) loads
   `@agent-plexus/adapters/<name>`; any other module is used through the config's `plugins`. Technology-specific data
   goes in `ext`. Every timeout, size, count or truncation length is an option declared once with `defineLimits` and
   set as the descriptor's `limits` (see [docs/limits.md](docs/limits.md)), never a literal in the code.
4. Tests: `test/<name>/*.test.ts` with `node:test`. `test/<name>/conformance.test.ts` runs the suite of the port with
   `checkAdapter(adapter, { options, fixtures })` from [`@agent-plexus/conformance`](packages/conformance) and expects
   no failures. A known gap is marked `todo` for its rule id only (`failuresOf`, `failuresExcept`), never removed. For
   an upstream service, add a contract test against a pinned version that skips when the service is down.
5. `src/<name>/README.md`: what it maps onto which port, tiers, an options table, a config snippet and its limits.
6. Add the adapter to the catalog in [docs/adapters.md](docs/adapters.md) (remove it from the Planned list if it was
   there) and its limits to [docs/limits.md](docs/limits.md).

Checks for the pull request, run only for the adapter you touched:

```bash
npm run typecheck -w @agent-plexus/adapters
node --conditions=@agent-plexus/source --test "packages/adapters/test/<name>/*.test.ts"
```

New adapters start as `experimental`; the criteria for `beta` and `stable` are in
[docs/adapters.md](docs/adapters.md#maturity).

## Change the core

The core (`packages/core`, `packages/cli`) and the spec (`spec/`) are owned by the maintainers. A core change starts
with a spec change:

1. Update the port page in `spec/ports/`, or [`spec/language.md`](spec/language.md) / [`spec/hooks.md`](spec/hooks.md).
2. Bump the port version in `PORT_VERSIONS` (`packages/core/src/ports.ts`): the minor while the port is `0.x`, the
   major after. The core then refuses adapters that declare the old version.
3. Then the core, then the adapters that declare the old version.

Documentation follows the same rule: a changed layer, port, hook, limit or CLI option must be reflected in `docs/` and
`spec/`. The core depends on nothing; keep it that way.

## Build and release

`npm run build` builds every package in dependency order (`scripts/build-packages.mjs`; `--clean` removes `dist/`
first). Packages ship `dist/` (JavaScript and type declarations), `README.md` and `LICENSE`; the `@agent-plexus/source`
export condition points at `src/` for development inside the repository only.

- `npm run release:dry`: clean build, then `npm pack --dry-run` of every package, to review the tarball contents.
- `npm run release`: clean build, typecheck, package tests, then `node scripts/publish-unpublished.mjs`.

The steps for the maintainer, including the npm organization and the GitHub Actions workflow, are in
[RELEASING.md](RELEASING.md).

## Style

TypeScript, ESM, Node >= 22.18, `node --test`, small files, short JSDoc. Zero runtime dependencies in the core
packages. Documentation in English, short sentences, tables over prose, no marketing language. Never put tokens or
secrets in errors, logs or telemetry. Framework and protocol names appear only in adapters.

## Documentation

- Layer pages follow one pattern: question, responsibility, ports, where it sits, standards, boundaries, configuration,
  telemetry, evaluation, how to swap, reference adapters, reference setup.
- Diagrams use the palette in [docs/diagrams.md](docs/diagrams.md) and are listed in its index.
- Describe what exists as implemented. Mark scheduled work as planned and any other technology as a candidate; the
  words are defined in [docs/adapters.md](docs/adapters.md#catalog).
- Check relative links by hand; check Mermaid blocks with the command in [docs/diagrams.md](docs/diagrams.md#checking-a-diagram).
