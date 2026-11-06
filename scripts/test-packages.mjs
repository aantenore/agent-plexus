// Runs the tests of every workspace against the TypeScript sources of the packages: `npm test --workspaces` with the
// `@agent-plexus/source` export condition set through NODE_OPTIONS, which the test scripts of the examples do not pass
// themselves (a copy of an example outside the repository runs against the published `dist/`).
//   node scripts/test-packages.mjs            every workspace with a test script
//   node scripts/test-packages.mjs --list     print the workspaces that would run and exit
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { npm, readJson, ROOT, workspaces } from './lib/common.mjs';

const SOURCE_CONDITION = '@agent-plexus/source';

const args = new Set(process.argv.slice(2));
const testable = workspaces().filter((dir) => readJson(join(ROOT, dir, 'package.json')).scripts?.test);
if (args.has('--list')) {
  console.log(testable.join('\n'));
  process.exit(0);
}
const options = [process.env.NODE_OPTIONS, `--conditions=${SOURCE_CONDITION}`].filter(Boolean).join(' ');
const res = spawnSync(npm, ['test', '--workspaces', '--if-present'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: options } });
process.exit(res.status ?? 1);
