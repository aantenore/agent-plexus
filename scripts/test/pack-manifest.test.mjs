import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../pack-manifest.mjs', import.meta.url));
const CONDITION = '@agent-plexus/source';

/** A manifest as the packages write theirs, plus the condition inside an array and a subpath that is only the condition. */
const ORIGINAL = `${JSON.stringify({
  name: 'x',
  version: '1.0.0',
  exports: {
    '.': { [CONDITION]: './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' },
    './sub': { [CONDITION]: './src/sub.ts', import: ['./dist/sub.js', { [CONDITION]: './src/sub.ts' }] },
    './src-only': { [CONDITION]: './src/only.ts' },
    './package.json': './package.json',
  },
  files: ['dist'],
}, null, 2)}\n`;

const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'plexus-manifest-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('strip drops the source condition at any depth and the entries left empty; restore puts the manifest back as it was', () => {
  inTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), ORIGINAL);
    assert.equal(run(dir, 'strip').status, 0);
    const stripped = readFileSync(join(dir, 'package.json'), 'utf8');
    assert.ok(!stripped.includes(CONDITION));
    assert.deepEqual(manifestOf(dir).exports, {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './sub': { import: ['./dist/sub.js'] },
      './package.json': './package.json',
    });
    assert.equal(readFileSync(join(dir, 'package.json.orig'), 'utf8'), ORIGINAL);
    // A second strip (a pack that failed before its postpack) starts from the kept original, never from a stripped copy.
    assert.equal(run(dir, 'strip').status, 0);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), stripped);
    assert.equal(readFileSync(join(dir, 'package.json.orig'), 'utf8'), ORIGINAL);
    assert.equal(run(dir, 'restore').status, 0);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), ORIGINAL);
    assert.ok(!existsSync(join(dir, 'package.json.orig')));
    // Nothing kept: restore has nothing to do.
    assert.equal(run(dir, 'restore').status, 0);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), ORIGINAL);
  });
});

test('a manifest without exports is left alone, and an unknown command is a usage error', () => {
  inTempDir((dir) => {
    const plain = '{\n  "name": "y",\n  "version": "1.0.0"\n}\n';
    writeFileSync(join(dir, 'package.json'), plain);
    assert.equal(run(dir, 'strip').status, 0);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), plain);
    assert.ok(!existsSync(join(dir, 'package.json.orig')));
    const bad = run(dir, 'frob');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage: node pack-manifest\.mjs strip \| restore/);
  });
});
