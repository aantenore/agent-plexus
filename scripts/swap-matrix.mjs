// Layer swap matrix: shows that a layer is replaced by changing only configuration. Each cell of examples/swap/cells.json
// names a profile of examples/swap/plexus.json and what is run against it; for every cell this script runs
//   - the tests of the cell in examples/swap/test/swap.test.ts (the tests named `cell <id>: ...`), and
//   - for a cell with `cli: true`, the command line as a user would: `check`, then `eval` of examples/swap/cases.json.
//
//   node scripts/swap-matrix.mjs                         every cell
//   node scripts/swap-matrix.mjs --only execution-sqlite,all
//   node scripts/swap-matrix.mjs --no-cli                the tests only
//   node scripts/swap-matrix.mjs --list                  print the cells, then exit
//
// Cell: { id, layer, profile, run, restart?, cli, description }. `profile` null is the base. `run` is what the tests do:
//   cases        check has no FAIL; the billing and product cases complete and route as the base; the crash case fails,
//                attributed to member billing
//   wait         a run waits on the host gate, then System.resume approves it (`restart`: from a new system on the same
//                journal); the completed steps replay
//   check-fails  check refuses the profile
// On the command line a `cases` cell must give `check` exit 0 and `eval` 2 passed, 1 failed (billing-crash, attributed to
// billing); a `check-fails` cell must give `check` exit 1. SWAP_SQLITE_PATH points at a temp file for every cell.
// Exit code 1 when a selected cell fails.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readJson, ROOT } from './lib/common.mjs';

const EXAMPLE = join('examples', 'swap');
const CELLS = join(ROOT, EXAMPLE, 'cells.json');
const CONFIG = join(EXAMPLE, 'plexus.json');
const CASES = join(EXAMPLE, 'cases.json');
const TESTS = join(EXAMPLE, 'test', 'swap.test.ts');
const CLI = join('packages', 'cli', 'src', 'cli.ts');
const NODE_ARGS = ['--conditions=@agent-plexus/source', '--disable-warning=ExperimentalWarning'];
const CRASH_CASE = 'billing-crash';
const CRASH_MEMBER = 'billing';
const TIMEOUT_S = Number(process.env.SWAP_TIMEOUT_S ?? 120);

const { values: opts } = parseArgs({
  options: { only: { type: 'string' }, 'no-cli': { type: 'boolean' }, list: { type: 'boolean' } },
  strict: true,
});
const csv = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const cells = readJson(CELLS);
/** Every case passes but the crash case. */
const EXPECTED_PASSED = readJson(join(ROOT, CASES)).length - 1;
if (opts.list) {
  for (const c of cells) console.log(`${c.id.padEnd(26)} ${c.layer.padEnd(12)} ${(c.profile ?? '(base)').padEnd(26)} ${c.run.padEnd(12)} ${c.cli ? 'cli' : '-'}`);
  process.exit(0);
}
const only = csv(opts.only);
const unknown = only.filter((id) => !cells.some((c) => c.id === id));
if (unknown.length) { console.error(`swap-matrix: unknown cell(s): ${unknown.join(', ')}`); process.exit(2); }
const selected = cells.filter((c) => !only.length || only.includes(c.id));

function node(argv, env) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...argv], { cwd: ROOT, env, encoding: 'utf8', timeout: TIMEOUT_S * 1000, killSignal: 'SIGKILL' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error?.code === 'ETIMEDOUT') return { status: -1, stdout: r.stdout ?? '', output, error: `timeout after ${TIMEOUT_S}s` };
  if (r.error) return { status: -1, stdout: r.stdout ?? '', output, error: r.error.message };
  return { status: r.status, stdout: r.stdout ?? '', output };
}

/** First line that reports a problem, else the last line of the output. */
function firstError(output) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error|fail|cannot|not |invalid|unknown|refused|timeout|✖/i.test(l)) ?? lines.at(-1) ?? 'no output').slice(0, 300);
}

/** The tests of a cell, selected by name. Passes when at least one ran and none failed. */
function tests(cell, env) {
  const r = node(['--test', `--test-name-pattern=^cell ${cell.id}: `, TESTS], env);
  const count = (label) => Number(new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(r.output)?.[1] ?? 0);
  const [pass, fail] = [count('pass'), count('fail')];
  if (r.error) return { ok: false, label: 'error', note: r.error };
  if (fail || !pass) return { ok: false, label: `${pass}/${pass + fail}`, note: fail ? firstError(r.output.split('✖ failing tests:')[1] ?? r.output) : 'no test matched the cell' };
  return { ok: true, label: `${pass}/${pass}` };
}

/** `check`, then `eval` for a cases cell, through the command line. */
function cli(cell, env) {
  const profile = cell.profile ? ['--profile', cell.profile] : [];
  const check = node([CLI, 'check', '--config', CONFIG, ...profile], env);
  const wanted = cell.run === 'check-fails' ? 1 : 0;
  if (check.status !== wanted) return { ok: false, check: 'fail', eval: '-', note: `check exit ${check.status}, expected ${wanted}: ${check.error ?? firstError(check.output)}` };
  if (cell.run !== 'cases') return { ok: true, check: 'refused', eval: '-' };

  const ev = node([CLI, 'eval', CASES, '--config', CONFIG, ...profile, '--json'], env);
  let report;
  try { report = JSON.parse(ev.stdout); } catch { return { ok: false, check: 'pass', eval: 'fail', note: `eval: ${ev.error ?? firstError(ev.output)}` }; }
  const failing = report.cases.filter((c) => !c.passed);
  const blamed = failing[0]?.attributions?.[0]?.member;
  const ok = report.passed === EXPECTED_PASSED && report.failed === 1 && failing[0]?.id === CRASH_CASE && blamed === CRASH_MEMBER;
  const summary = `${report.passed} passed, ${report.failed} failed`;
  return ok
    ? { ok, check: 'pass', eval: summary }
    : { ok, check: 'pass', eval: summary, note: `expected ${EXPECTED_PASSED} passed and ${CRASH_CASE} failed, attributed to ${CRASH_MEMBER}; got ${failing.map((c) => `${c.id} -> ${c.attributions?.[0]?.member ?? 'none'}`).join(', ')}` };
}

const results = [];
for (const cell of selected) {
  const dir = mkdtempSync(join(tmpdir(), 'swap-matrix-'));
  const env = { ...process.env, SWAP_SQLITE_PATH: join(dir, 'journal.db') };
  try {
    const t = tests(cell, env);
    const c = cell.cli && !opts['no-cli'] ? cli(cell, env) : { ok: true, check: '-', eval: '-' };
    const r = { id: cell.id, layer: cell.layer, profile: cell.profile ?? '(base)', run: cell.run, status: t.ok && c.ok ? 'pass' : 'fail', tests: t.label, check: c.check, eval: c.eval, note: [t.note, c.note].filter(Boolean).join('; ') };
    results.push(r);
    console.log(`${r.status.padEnd(5)} ${r.id}${r.note ? `: ${r.note}` : ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (s) => results.filter((r) => r.status === s).length;
console.log([
  '',
  '| Cell | Layer | Profile | Run | Tests | CLI check | CLI eval | Status |',
  '|---|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.layer} | ${r.profile} | ${r.run} | ${r.tests} | ${r.check} | ${r.eval} | ${r.status} |`),
  '',
  `${count('pass')} passed, ${count('fail')} failed`,
].join('\n'));
process.exit(count('fail') ? 1 : 0);
