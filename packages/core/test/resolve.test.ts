import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkDescriptor, compatiblePortVersion, defineAdapter, type AdapterDescriptor } from '../src/adapter.ts';
import { AdapterError } from '../src/errors.ts';
import { PORT_VERSIONS } from '../src/ports.ts';
import { prototypeHost } from '../src/prototype-host.ts';
import { createAdapter, descriptorsOf, loadDescriptor, pluginLoader, type DescriptorLoader } from '../src/resolve.ts';

const member = (extra: Record<string, unknown> = {}) => ({
  fills: 'MemberPort', name: 'm', maps: { technology: 'test' }, portVersion: PORT_VERSIONS.MemberPort, tiers: ['prototype'],
  create: () => ({ name: 'm', describe: async () => { throw new Error('unused'); }, invoke: async () => { throw new Error('unused'); } }),
  ...extra,
});
const ctx = { system: 's', name: 'm', cwd: '.', env: {}, telemetry: prototypeHost().telemetry };
const loading = (d: unknown): DescriptorLoader => async () => d as AdapterDescriptor;

test('checkDescriptor: a sound descriptor has no problems; a host needs no portVersion', () => {
  assert.deepEqual(checkDescriptor(member()), []);
  assert.deepEqual(checkDescriptor(member({ capabilities: { resume: true, cancel: false } })), []);
  const { portVersion: _v, ...host } = member({ fills: 'Host' });
  assert.deepEqual(checkDescriptor(host), []);
});

test('checkDescriptor: every shape problem is reported', () => {
  assert.deepEqual(checkDescriptor(null), ['descriptor must be an object']);
  const problems = checkDescriptor({
    fills: 'NopePort', name: '', maps: {}, tiers: ['staging'], optionsSchema: [], portVersion: '1', create: 1,
  });
  assert.deepEqual(problems, [
    'fills must be one of MemberPort, RegistryPort, AgentRouterPort, TopologyPort, ExecutionPort, AttributionPort, Host',
    'name must be a non-empty string',
    'maps must name a standard or a technology',
    'tiers must be a non-empty subset of prototype, production',
    'optionsSchema must be an object',
    'portVersion must be a semver version, got "1"',
    'create must be a function',
  ]);
  assert.deepEqual(checkDescriptor(member({ portVersion: undefined })), ['portVersion is required (the core implements MemberPort 0.1.0)']);
  assert.deepEqual(checkDescriptor(member({ fills: 'RegistryPort', capabilities: {} })), ['capabilities are declared by MemberPort adapters only']);
  assert.deepEqual(checkDescriptor(member({ capabilities: { resume: 'yes', pause: true } })), ['capabilities.resume: must be a boolean', 'capabilities.pause: unknown (known: resume, cancel, checkpoint, waits)']);
});

test('compatiblePortVersion: same major, and same minor while the major is 0', () => {
  assert.equal(compatiblePortVersion('0.1.3', '0.1.0'), true);
  assert.equal(compatiblePortVersion('0.2.0', '0.1.0'), false);
  assert.equal(compatiblePortVersion('1.4.0', '1.0.0'), true);
  assert.equal(compatiblePortVersion('2.0.0', '1.0.0'), false);
  assert.equal(compatiblePortVersion('x', '1.0.0'), false);
});

test('createAdapter rejects an adapter of another port version, naming the adapter, its version and the core\'s', async () => {
  await assert.rejects(
    createAdapter(loading(member({ portVersion: '1.0.0' })), 'MemberPort', { adapter: 'm' }, ctx, '$.members.a'),
    (err: unknown) => err instanceof AdapterError
      && err.message === '$.members.a: adapter "m" cannot be used: implements MemberPort 1.0.0, the core implements MemberPort 0.1.0',
  );
  await assert.rejects(createAdapter(loading(member({ maps: {} })), 'MemberPort', { adapter: 'm' }, ctx, '$.members.a'), /maps must name a standard or a technology/);
  await assert.rejects(createAdapter(loading(member()), 'RegistryPort', { adapter: 'm' }, ctx, '$.ports.registry'), /fills MemberPort, expected RegistryPort/);
  assert.equal((await createAdapter(loading(member()), 'MemberPort', { adapter: 'm' }, ctx, '$.members.a')).instance.name, 'm');
});

test('descriptorsOf finds descriptors in adapters, default and named exports, once each', () => {
  const a = member({ name: 'a' });
  const b = member({ name: 'b' });
  assert.deepEqual(descriptorsOf({ adapters: [a, b], default: a, other: b, noise: { name: 'x' }, n: 1 }).map((d) => d.name), ['a', 'b']);
});

test('pluginLoader: plugin descriptors first, by port and name; other names fall back; a broken plugin is named', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-plugins-'));
  try {
    const descriptor = (name: string, fills: string) => `{ fills: '${fills}', name: '${name}', maps: { technology: 't' }, portVersion: '0.1.0', tiers: ['prototype'], create: () => ({ name: '${name}' }) }`;
    await writeFile(join(dir, 'one.mjs'), `export const adapters = [${descriptor('shared', 'MemberPort')}, ${descriptor('shared', 'RegistryPort')}];\nexport const tag = 'one';`);
    await writeFile(join(dir, 'two.mjs'), `export default ${descriptor('shared', 'MemberPort').replace("'t'", "'second'")};`);
    const fallbackCalls: string[] = [];
    const fallback: DescriptorLoader = async (fills, name) => { fallbackCalls.push(`${fills}/${name}`); return member({ name }) as AdapterDescriptor; };
    const load = pluginLoader(['./one.mjs', './two.mjs'], fallback);
    const found = await load('MemberPort', 'shared', dir);
    assert.equal(found.maps.technology, 't');
    assert.equal((await load('RegistryPort', 'shared', dir)).fills, 'RegistryPort');
    assert.equal((await load('MemberPort', 'elsewhere', dir)).name, 'elsewhere');
    assert.deepEqual(fallbackCalls, ['MemberPort/elsewhere']);
    await assert.rejects(pluginLoader(['./missing.mjs'], fallback)('MemberPort', 'x', dir), /plugin "\.\/missing\.mjs" failed to load/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pluginLoader refuses a plugin named by a URL that is not a file: data, http, https, node and any other scheme', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-plugins-'));
  try {
    const descriptor = `{ fills: 'MemberPort', name: 'm', maps: { technology: 't' }, portVersion: '0.1.0', tiers: ['prototype'], create: () => ({ name: 'm' }) }`;
    const urls = [
      `data:text/javascript,export const adapters = [${encodeURIComponent(descriptor)}];`,
      'DATA:text/javascript,export default 1',
      'http://example.com/adapters.mjs',
      'https://example.com/adapters.mjs',
      'node:fs',
      'blob:nodedata:1',
    ];
    for (const url of urls) {
      const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
      await assert.rejects(
        pluginLoader([url], async () => member() as AdapterDescriptor)('MemberPort', 'm', dir),
        (err: Error) => err.message.includes(`a "${scheme}:" URL is not accepted as a module: name a file path or a package`),
        url,
      );
    }
    // a file path, also written as a file: URL, still loads
    await writeFile(join(dir, 'local.mjs'), `export const adapters = [${descriptor}];`);
    assert.equal((await pluginLoader(['./local.mjs'])('MemberPort', 'm', dir)).name, 'm');
    assert.equal((await pluginLoader([pathToFileURL(join(dir, 'local.mjs')).href])('MemberPort', 'm', dir)).name, 'm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Writes a package under `<dir>/node_modules/<name>`: its manifest and its files. */
async function installed(dir: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>): Promise<void> {
  const root = join(dir, 'node_modules', name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
}

test('pluginLoader resolves bare plugins as imports from the config directory: ESM-only, dual and CommonJS packages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-packages-'));
  try {
    const descriptor = (name: string) => `{ fills: 'MemberPort', name: '${name}', maps: { technology: 't' }, portVersion: '0.1.0', tiers: ['prototype'], create: () => ({ name: '${name}' }) }`;
    await installed(dir, 'esm-only', { type: 'module', exports: { '.': { import: './index.js' } } }, { 'index.js': `export const adapters = [${descriptor('esm-only')}];` });
    await installed(dir, 'dual', { exports: { '.': { require: './index.cjs', import: './index.mjs' } } }, {
      'index.cjs': `module.exports = { adapters: [${descriptor('dual-cjs')}] };`,
      'index.mjs': `export const adapters = [${descriptor('dual-esm')}];`,
    });
    await installed(dir, '@scope/cjs', { main: 'main.cjs' }, { 'main.cjs': `module.exports = { adapters: [${descriptor('cjs')}] };` });
    await installed(dir, 'nothing', { type: 'module', exports: './index.js' }, { 'index.js': 'export const tag = 1;' });
    const fallbackCalls: string[] = [];
    const fallback: DescriptorLoader = async (fills, name) => { fallbackCalls.push(name); throw new Error(`no adapter ${name}`); };
    const load = pluginLoader(['esm-only', 'dual', '@scope/cjs'], fallback);
    assert.equal((await load('MemberPort', 'esm-only', dir)).name, 'esm-only');
    assert.equal((await load('MemberPort', 'dual-esm', dir)).name, 'dual-esm');
    assert.equal((await load('MemberPort', 'cjs', dir)).name, 'cjs');
    await assert.rejects(load('MemberPort', 'dual-cjs', dir), /no adapter dual-cjs/);
    assert.deepEqual(fallbackCalls, ['dual-cjs']);
    await assert.rejects(pluginLoader(['nothing'], fallback)('MemberPort', 'x', dir), /plugin "nothing" failed to load: it exports no adapter descriptors/);
    // A package not installed where the config is fails: it is never looked up from the core's own location.
    await assert.rejects(pluginLoader(['@agent-plexus/adapters/function-member'], fallback)('MemberPort', 'x', dir), /is not installed where the config is/);
    await assert.rejects(pluginLoader(['esm-only/missing'], fallback)('MemberPort', 'x', dir), /exports no "\.\/missing" for import/);
    assert.deepEqual(fallbackCalls, ['dual-cjs']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('descriptorsOf searches a CommonJS default export object', () => {
  const a = member({ name: 'a' });
  assert.deepEqual(descriptorsOf({ default: { adapters: [a] } }).map((d) => d.name), ['a']);
});

test('portVersion is required by the type for a port and optional for a host; loading still checks it', () => {
  const create = () => { throw new Error('unused'); };
  // @ts-expect-error a port adapter without portVersion does not type-check
  const unversioned = defineAdapter({ fills: 'RegistryPort', name: 'r', maps: { technology: 't' }, tiers: ['prototype'], create });
  assert.deepEqual(checkDescriptor(unversioned), ['portVersion is required (the core implements RegistryPort 0.1.0)']);
  const host = defineAdapter({ fills: 'Host', name: 'h', maps: { technology: 't' }, tiers: ['prototype'], create });
  assert.deepEqual(checkDescriptor(host), []);
});

/** The module text of an adapters package subpath: one plain MemberPort descriptor named `name`. */
const subpathModule = (name: string, technology: string) =>
  `export const adapters = [{ fills: 'MemberPort', name: '${name}', maps: { technology: '${technology}' }, portVersion: '0.1.0', tiers: ['prototype'], create: (o, ctx) => ({ name: ctx.name }) }];`;

test('loadDescriptor finds @agent-plexus/adapters next to the config first, and falls back on the core\'s own copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plexus-adapters-'));
  try {
    // Nothing installed next to the config: the package the core sees (this checkout's) is used.
    assert.equal((await loadDescriptor('MemberPort', 'function-member', dir)).name, 'function-member');
    await assert.rejects(loadDescriptor('MemberPort', 'does-not-exist', dir), /is not one of @agent-plexus\/adapters/);

    await installed(dir, '@agent-plexus/adapters', { type: 'module', exports: { './fake-member': './fake-member.mjs', './function-member': './function-member.mjs' } }, {
      'fake-member.mjs': subpathModule('fake-member', 'local'),
      'function-member.mjs': subpathModule('function-member', 'local copy'),
    });
    assert.equal((await loadDescriptor('MemberPort', 'fake-member', dir)).maps.technology, 'local');
    // The copy next to the config wins over the one next to the core.
    assert.equal((await loadDescriptor('MemberPort', 'function-member', dir)).maps.technology, 'local copy');
    // A name the local package does not export is not looked up next to the core.
    await assert.rejects(loadDescriptor('MemberPort', 'static-registry', dir), /is not one of @agent-plexus\/adapters \(name another adapter/);
    await assert.rejects(loadDescriptor('RegistryPort', 'fake-member', dir), /fills MemberPort, expected RegistryPort/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadDescriptor names both places when @agent-plexus/adapters is installed in neither', async () => {
  // A copy of the core's sources outside this checkout, so Node finds no node_modules from it either.
  const dir = await mkdtemp(join(tmpdir(), 'plexus-no-adapters-'));
  try {
    const src = join(dir, 'core', 'src');
    await cp(fileURLToPath(new URL('../src/', import.meta.url)), src, { recursive: true });
    const project = join(dir, 'project');
    await mkdir(project);
    const script = join(dir, 'load.mjs');
    await writeFile(script, `
import { loadDescriptor } from ${JSON.stringify(join(src, 'resolve.ts'))};
try {
  await loadDescriptor('MemberPort', 'function-member', ${JSON.stringify(project)});
  console.log('loaded');
} catch (err) {
  console.log(err.message);
}
`);
    const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `is not installed next to the config (${project}) or next to @agent-plexus/core (npm install @agent-plexus/adapters)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
