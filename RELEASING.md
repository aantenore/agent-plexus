# Releasing

Every package under `packages/*` is published to npm, all with the same version: `core`, `cli`, `conformance` and
`adapters` (every reference adapter, one subpath export each) under the `@agent-plexus` scope, plus the unscoped
`agent-plexus`, a stub that only forwards to `@agent-plexus/cli` so that `npx agent-plexus` runs this project's command
line and the name cannot be taken by someone else; a release publishes five packages. The packages under `examples/*`
are private and are not part of the release.

## First release

1. Sign in to npm: `npm login` (`npm whoami` prints the account).
2. Check the scope: `npm view @agent-plexus/core`. A 404 means the scope has no packages yet. If the
   `agent-plexus` organization does not exist, create it at <https://www.npmjs.com/org/create> (the free plan covers
   public packages) and make sure your account is an owner of it.
3. From a clean checkout of `main`: `npm ci`.
4. `npm run release:dry`: clean build in dependency order, then the file list of every tarball. Check that each one
   holds `dist/`, `README.md`, `LICENSE` and `package.json` only, plus `templates/` (cli) and `cli.js` (the unscoped `agent-plexus` stub).
5. `npm run release`: clean build, typecheck, package tests, then `node scripts/publish-unpublished.mjs`, which
   publishes each package whose version is not on npm yet. npm asks for the one-time password if the account uses
   2FA. If it stops (rate limit, expired login), run `node scripts/publish-unpublished.mjs` again: it resumes with
   what is still missing (`--list` only prints it).
6. Check one package: `npm view @agent-plexus/cli version`, then in an empty folder `npm install @agent-plexus/cli`
   and `npx agent-plexus --help`.

## Later releases

Each release is one commit, `release: x.y.z`, with an annotated tag `vx.y.z` on it; that commit is the one npm records
as `gitHead`, and the GitHub release carries its CHANGELOG section. For 0.3.0:

1. Set the new version in every package and in the internal dependency ranges, for example
   `npm version 0.3.0 --workspaces --no-git-tag-version`, then update the `^0.2.0` ranges (the one of `agent-plexus` on
   `@agent-plexus/cli` included) and the exact `0.2.0` development pins on `@agent-plexus/*` packages (and in
   `examples/*`) to the new version and run `npm install` to refresh the lockfile. While the major is 0 a caret range
   stops at the next minor (`^0.2.0` does not match `0.3.0`), so every internal range moves with the version: the
   packages are released in lockstep.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## 0.3.0 - <date>` (the day of the release, `YYYY-MM-DD`) and start a
   new, empty `## Unreleased` above it.
3. Commit the version bump, the lockfile and the CHANGELOG as `release: 0.3.0`, then tag that commit and push both:
   `git tag -a v0.3.0 -m 0.3.0`, `git push origin main v0.3.0`.
4. From the tagged commit: `npm run release:dry`, then `npm run release`, or the workflow on the tag:
   `gh workflow run release.yml --ref v0.3.0 -f dry_run=false`. `scripts/publish-unpublished.mjs` refuses a version
   whose tag `v<version>` is not at `HEAD` (`--allow-untagged` publishes anyway, for a repair only). A version that is
   already on npm cannot be published again.
5. Create the GitHub release from the CHANGELOG section:
   `awk '/^## 0\.3\.0 /{f=1; next} /^## /{f=0} f' CHANGELOG.md > notes.md`, then
   `gh release create v0.3.0 --verify-tag --title 0.3.0 --notes-file notes.md`.
6. Check: `npm view @agent-plexus/core@0.3.0 gitHead` prints the commit of `git rev-parse 'v0.3.0^{commit}'`.

## From GitHub Actions

`.github/workflows/release.yml` runs the same steps on manual dispatch only and publishes the missing packages with
[provenance](https://docs.npmjs.com/generating-provenance-statements). It needs a repository secret `NPM_TOKEN`: an
npm granular access token with read and write access to the `@agent-plexus` packages (Settings, Secrets and
variables, Actions). On an account with 2FA the token must be allowed to publish without a one-time password. Give
it a short expiry and revoke it after the release. Run the workflow with
`gh workflow run release.yml --ref v0.3.0 -f dry_run=true` (or from the Actions tab, on the tag), then again with
`dry_run` unchecked: `gh workflow run release.yml --ref v0.3.0 -f dry_run=false`. The checkout fetches the tags, so
the publish step refuses a run whose `HEAD` is not the tagged commit.

npm limits how many new packages an account can create in a short time (HTTP 429). A first release of every
package can hit it: wait and run the release again, it publishes only what is missing.

## Notes

- 0.2.0 follows the published 0.1.0 of `@agent-plexus/core`: the core gained exports, so every package moved to 0.2.0
  together, `@agent-plexus/conformance` included, with internal ranges at `^0.2.0`. Port versions (`PORT_VERSIONS`)
  are unchanged at 0.1.0: adapters built for 0.1.0 load as before.

- `prepack` in each package builds it, copies the root `LICENSE` into the package folder (ignored by git) and strips
  the `@agent-plexus/source` export condition from `package.json` (`scripts/pack-manifest.mjs`; the original is kept as
  `package.json.orig`, ignored by git, and `postpack` puts it back), so a published manifest never points at `src/`.
  The build of a package needs the `dist/` of the packages it depends on, which `npm run build` (dependency order)
  provides. `agent-plexus` has no build: its `cli.js` is published as is.
- `@agent-plexus/adapters` declares the libraries of single adapters (`@a2a-js/sdk`, `@agent-layers/core`) as optional
  peer dependencies, and as dev dependencies for its tests. The agent-layers packages are published separately from the
  agent-layers repository; their range (`^0.4.0 || ^0.5.0`) moves when agent-layers changes its minor.
- 0.2.0 replaces the nine `@agent-plexus/adapter-<name>` packages (0.1.0) with `@agent-plexus/adapters`; see
  [CHANGELOG.md](CHANGELOG.md). The old packages are deprecated on npm, for example
  `npm deprecate @agent-plexus/adapter-skill-router "moved to @agent-plexus/adapters/skill-router"`.
- The releases before this flow are tagged on the commits npm records as their `gitHead`:
  `git tag -a v0.1.0 7c709a4 -m 0.1.0` and `git tag -a v0.2.0 ebb65d8 -m 0.2.0`. The `0.0.0-stage` placeholders of
  `core`, `cli`, `conformance` and `adapters` are deprecated with
  `npm deprecate @agent-plexus/<name>@0.0.0-stage "placeholder, use >=0.2.0"`.
