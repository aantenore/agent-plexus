# Releasing

Every package under `packages/*` and `adapters/*` is published to npm under the `@agent-plexus` scope, all with the
same version. The packages under `examples/*` are private and are not part of the release.

## First release

1. Sign in to npm: `npm login` (`npm whoami` prints the account).
2. Check the scope: `npm view @agent-plexus/core`. A 404 means the scope has no packages yet. If the
   `agent-plexus` organization does not exist, create it at <https://www.npmjs.com/org/create> (the free plan covers
   public packages) and make sure your account is an owner of it.
3. From a clean checkout of `main`: `npm ci`.
4. `npm run release:dry`: clean build in dependency order, then the file list of every tarball. Check that each one
   holds `dist/`, `README.md`, `LICENSE` and `package.json` only.
5. `npm run release`: clean build, typecheck, package tests, then `node scripts/publish-unpublished.mjs`, which
   publishes each package whose version is not on npm yet. npm asks for the one-time password if the account uses
   2FA. If it stops (rate limit, expired login), run `node scripts/publish-unpublished.mjs` again: it resumes with
   what is still missing (`--list` only prints it).
6. Check one package: `npm view @agent-plexus/cli version`, then in an empty folder `npm install @agent-plexus/cli`
   and `npx agent-plexus --help`.

## Later releases

1. Set the new version in every package and in the internal dependency ranges, for example
   `npm version 0.3.0 --workspaces --no-git-tag-version`, then update the `^0.2.0` ranges and the exact `0.2.0`
   development pins on `@agent-plexus/*` packages (and in `examples/*`) to the new version and run `npm install` to
   refresh the lockfile. While the major is 0 a caret range stops at the next minor (`^0.2.0` does not match `0.3.0`),
   so every internal range moves with the version: the packages are released in lockstep.
2. Commit, tag `v0.3.0`, push.
3. `npm run release:dry`, then `npm run release`. A version that is already on npm cannot be published again.

## From GitHub Actions

`.github/workflows/release.yml` runs the same steps on manual dispatch only and publishes the missing packages with
[provenance](https://docs.npmjs.com/generating-provenance-statements). It needs a repository secret `NPM_TOKEN`: an
npm granular access token with read and write access to the `@agent-plexus` packages (Settings, Secrets and
variables, Actions). On an account with 2FA the token must be allowed to publish without a one-time password. Give
it a short expiry and revoke it after the release. Run the workflow with
`gh workflow run release.yml -f dry_run=true` (or from the Actions tab), then again with `dry_run` unchecked:
`gh workflow run release.yml -f dry_run=false`.

npm limits how many new packages an account can create in a short time (HTTP 429). A first release of every
package can hit it: wait and run the release again, it publishes only what is missing.

## Notes

- 0.2.0 follows the published 0.1.0 of `@agent-plexus/core`: the core gained exports, so every package moved to 0.2.0
  together, `@agent-plexus/conformance` included, with internal ranges at `^0.2.0`. Port versions (`PORT_VERSIONS`)
  are unchanged at 0.1.0: adapters built for 0.1.0 load as before.

- `prepack` in each package builds it and copies the root `LICENSE` into the package folder (ignored by git). The
  build of a package needs the `dist/` of the packages it depends on, which `npm run build` (dependency order)
  provides.
- Packages depend on `@agent-layers/core` only where an adapter needs it; that package is published separately from
  the agent-layers repository.
