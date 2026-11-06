// Copies the starter that `agent-plexus init` writes into `packages/cli/templates/` (ignored by git, published with the
// CLI): the config, the members and the cases of `examples/offline`, and the starter's README, so the starter cannot
// drift from the example the tests run. Runs from the CLI's `build` and `pretest` scripts; replaces the folder each time.
//   node scripts/copy-starter.mjs
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/common.mjs';

/** Where each starter file comes from, relative to the repository root; the key is its path in the starter. */
const SOURCES = {
  'plexus.json': 'examples/offline/plexus.json',
  'cases.json': 'examples/offline/cases.json',
  members: 'examples/offline/members',
  'README.md': 'packages/cli/starter/README.md',
};
const TARGET = join(ROOT, 'packages/cli/templates');

rmSync(TARGET, { recursive: true, force: true });
for (const [to, from] of Object.entries(SOURCES)) cpSync(join(ROOT, from), join(TARGET, to), { recursive: true });
