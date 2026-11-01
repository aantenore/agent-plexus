import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Condition, MemberResult, TopologyNode } from './shapes.ts';
import { errorMessage } from './util.ts';
import { walkTopology } from './topology-walk.ts';

/** A condition function: synchronous and pure. */
export type ConditionFn = (result: MemberResult) => boolean;
export type ConditionFns = Readonly<Record<string, ConditionFn>>;

const oneOf = <T>(expected: T | T[], actual: T | undefined): boolean =>
  actual !== undefined && (Array.isArray(expected) ? expected.includes(actual) : expected === actual);

function matchesOutput(pattern: string, output: string): boolean {
  try {
    return new RegExp(pattern).test(output);
  } catch {
    return false;
  }
}

/** True when the result satisfies every field the condition sets; a `fn` must be in `fns`. */
export function matchesCondition(cond: Condition, result: MemberResult, fns: ConditionFns): boolean {
  if (cond.status !== undefined && !oneOf(cond.status, result.status)) return false;
  if (cond.code !== undefined && !oneOf(cond.code, result.reason?.code)) return false;
  if (cond.ext && !Object.entries(cond.ext).every(([k, v]) => isDeepStrictEqual(result.ext?.[k], v))) return false;
  if (cond.matches !== undefined && !matchesOutput(cond.matches, result.output)) return false;
  if (cond.fn !== undefined) {
    const fn = fns[cond.fn];
    if (!fn) throw new Error(`condition function "${cond.fn}" is not loaded`);
    if (!fn(result)) return false;
  }
  return true;
}

function conditionsOf(node: TopologyNode): Condition[] {
  if (typeof node === 'string') return [];
  if (node.kind === 'loop') return [node.until];
  if (node.kind === 'graph') return node.edges.flatMap((e) => (e.when ? [e.when] : []));
  return [];
}

async function loadFn(spec: string, cwd: string): Promise<ConditionFn> {
  const at = spec.lastIndexOf('#');
  if (at <= 0 || at === spec.length - 1) throw new Error(`condition function "${spec}": expected "<module>#<export>"`);
  const file = resolve(cwd, spec.slice(0, at));
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`condition function "${spec}": cannot load ${file}: ${errorMessage(err)}`);
  }
  const fn = mod[spec.slice(at + 1)];
  if (typeof fn !== 'function') throw new Error(`condition function "${spec}": ${spec.slice(at + 1)} is not an exported function`);
  return fn as ConditionFn;
}

/** Imports every `fn` ("<module>#<export>", module relative to `cwd`) used by the conditions of a topology. */
export async function loadConditionFns(spec: TopologyNode, cwd: string): Promise<ConditionFns> {
  const specs = new Set<string>();
  walkTopology(spec, (node) => { for (const c of conditionsOf(node)) if (c.fn) specs.add(c.fn); });
  const entries = await Promise.all([...specs].map(async (s) => [s, await loadFn(s, cwd)] as const));
  return Object.fromEntries(entries);
}
