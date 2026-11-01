import type { Attribution, EvalCase, RunStatus, Score, StopReason } from '@agent-plexus/core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, type Io } from '../io.ts';
import { attributionLine, publicResult, scoreLine } from '../format.ts';
import { openProject, type ProjectArgs } from '../project.ts';

export interface EvalArgs extends ProjectArgs {
  cases: string;
  json?: boolean;
}

interface CaseReport {
  id: string;
  passed: boolean;
  status: RunStatus;
  reason?: StopReason;
  output: string;
  scores: Score[];
  attributions: Attribution[];
}

async function readCases(file: string): Promise<EvalCase[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${file}: cannot read as JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new CliError(`${file}: expected an array of cases`);
  raw.forEach((c, i) => {
    const ok = typeof c === 'object' && c !== null && typeof c.id === 'string' && c.id
      && (typeof c.input === 'string' || typeof c.input?.text === 'string');
    if (!ok) throw new CliError(`${file}: case [${i}] needs a string "id" and an "input" (text, or an object with "text")`);
  });
  return raw as EvalCase[];
}

/** Runs every case, scores it, and attributes the failures. Exit 1 when any case fails. */
export async function evaluate(io: Io, args: EvalArgs): Promise<number> {
  const cases = await readCases(resolve(io.cwd, args.cases));
  const { system } = await openProject(io, args);
  const reports: CaseReport[] = [];
  try {
    for (const evalCase of cases) {
      const result = await system.run(evalCase.input);
      const scores = await system.score(evalCase, result);
      const passed = result.status === 'completed' && scores.every((s) => s.value >= 1);
      const attributions = passed ? [] : await system.attribute(result, scores);
      const { status, reason, output } = publicResult(result);
      reports.push({ id: evalCase.id, passed, status, ...(reason ? { reason } : {}), output, scores, attributions });
    }
  } finally {
    await system.close();
  }
  const failed = reports.filter((r) => !r.passed).length;
  if (args.json) {
    io.out(JSON.stringify({ passed: reports.length - failed, failed, cases: reports }, null, 2));
    return failed ? 1 : 0;
  }
  for (const r of reports) {
    io.out(`${r.passed ? 'PASS' : 'FAIL'} ${r.id}`);
    if (r.passed) continue;
    if (r.status !== 'completed') io.out(`  run ${r.status}${r.reason ? ` ${r.reason.code}` : ''}`);
    for (const s of r.scores.filter((x) => x.value < 1)) io.out(`  score ${scoreLine(s)}`);
    for (const a of r.attributions) io.out(`  attribution ${attributionLine(a)}`);
  }
  io.out(`eval: ${reports.length - failed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}
