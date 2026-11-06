// Makes the `bin` targets of the package in the current folder executable, as npm does when it installs the package,
// so a built CLI runs as `packages/cli/dist/cli.js` from a checkout too. Runs from the package's `build` script; a
// no-op on Windows, where the shell runs the file through `node` anyway.
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './lib/common.mjs';

if (process.platform !== 'win32') {
  const { bin } = readJson(join(process.cwd(), 'package.json'));
  const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
  for (const target of targets) {
    const file = join(process.cwd(), target);
    if (existsSync(file)) chmodSync(file, 0o755);
  }
}
