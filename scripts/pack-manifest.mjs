// Keeps the `@agent-plexus/source` export condition out of the published manifests: it points at `src/`, which is not
// in the tarball (`files` is `dist`), and only a checkout passes the condition. Runs from each package's `prepack` and
// `postpack`, in the package folder.
//   node ../../scripts/pack-manifest.mjs strip     keep a copy of package.json as package.json.orig, drop the condition
//   node ../../scripts/pack-manifest.mjs restore   put the kept copy back (nothing to do without one)
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_CONDITION = '@agent-plexus/source';

const manifest = join(process.cwd(), 'package.json');
const kept = `${manifest}.orig`;

/**
 * The exports map without the source condition, at any depth; an entry that is left with nothing (an object or an
 * array that held only the condition) is dropped, so no subpath is published with an empty target.
 */
function withoutSource(value) {
  if (Array.isArray(value)) {
    const kept = value.map(withoutSource).filter((v) => v !== undefined);
    return kept.length || !value.length ? kept : undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === SOURCE_CONDITION) continue;
    const kept = withoutSource(inner);
    if (kept !== undefined) out[key] = kept;
  }
  return Object.keys(out).length || !Object.keys(value).length ? out : undefined;
}

function restore() {
  if (!existsSync(kept)) return;
  renameSync(kept, manifest);
}

function strip() {
  restore();
  const text = readFileSync(manifest, 'utf8');
  const pkg = JSON.parse(text);
  if (pkg.exports === undefined) return;
  copyFileSync(manifest, kept);
  writeFileSync(manifest, `${JSON.stringify({ ...pkg, exports: withoutSource(pkg.exports) }, null, 2)}\n`);
}

const command = process.argv[2];
if (command === 'strip') strip();
else if (command === 'restore') restore();
else {
  console.error('usage: node pack-manifest.mjs strip | restore');
  process.exit(2);
}
