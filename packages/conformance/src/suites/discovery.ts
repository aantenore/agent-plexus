import { isDeepStrictEqual } from 'node:util';
import type { AgentEntry, AgentRouterPort, Attrs, Caller, CandidateFilter, RegistryPort, RouteQuestion, RunContext, RunInput } from '@agent-plexus/core';
import { Checks, uniqueId } from '../check.ts';
import { entryProblems } from '../shapes.ts';

const skill = (id: string, tags: string[]) => ({ id, name: id, description: `${id} skill`, tags });
const entry = (id: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({
  id, name: id, description: `${id} agent`, skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true }, ...extra,
});

/** Entries the suites hand to routers, and registries that list the configured members. */
export const SAMPLE_ENTRIES: readonly AgentEntry[] = [
  entry('billing', { description: 'Answers invoice, refund and charge questions', skills: [skill('invoices', ['billing', 'money'])], attrs: { region: 'eu', tier: 1 } }),
  entry('manuals', { description: 'Answers product and setup questions', skills: [skill('setup', ['product']), skill('faq', ['product', 'docs'])], attrs: { region: ['eu', 'us'] } }),
  entry('triage', { description: 'First line of support', attrs: { region: 'us' } }),
];

// Registry ----------------------------------------------------------------------------------------------------------

export interface RegistryFixtures {
  /** Ids `list()` must return, when the test knows them. */
  ids?: string[];
  /** Filters checked besides the ones the suite derives from the entries. */
  filters?: CandidateFilter[];
}

const asList = (v: Attrs[string]): (string | number | boolean)[] => (Array.isArray(v) ? v : [v]);

/** The filter rules of the spec, as a reference. */
export function specMatches(e: AgentEntry, filter: CandidateFilter): boolean {
  if (filter.skills?.length && !e.skills.some((s) => filter.skills!.includes(s.id))) return false;
  if (filter.tags?.length) {
    const tags = new Set(e.skills.flatMap((s) => s.tags));
    if (!filter.tags.every((t) => tags.has(t))) return false;
  }
  for (const [key, wanted] of Object.entries(filter.attrs ?? {})) {
    const have = e.attrs && Object.hasOwn(e.attrs, key) ? e.attrs[key] : undefined;
    if (have === undefined) return false;
    const haveList = asList(have);
    if (!asList(wanted).some((w) => haveList.includes(w))) return false;
  }
  return true;
}

/** Filters that exercise each rule over the entries a registry lists. */
function derivedFilters(entries: AgentEntry[]): CandidateFilter[] {
  const out: CandidateFilter[] = [{}, { skills: [], tags: [] }, { skills: ['conformance-missing'] }, { tags: ['conformance-missing'] }];
  const skills = [...new Set(entries.flatMap((e) => e.skills.map((s) => s.id)))];
  const tags = [...new Set(entries.flatMap((e) => e.skills.flatMap((s) => s.tags)))];
  for (const s of skills) out.push({ skills: [s] });
  if (skills.length > 1) out.push({ skills: skills.slice(0, 2) });
  for (const t of tags) out.push({ tags: [t] });
  if (tags.length > 1) out.push({ tags: tags.slice(0, 2) });
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.attrs ?? {})) {
      out.push({ attrs: { [k]: v } });
      out.push({ attrs: { [k]: [...asList(v).map(String), 'conformance-other'] } });
      for (const one of asList(v)) out.push({ attrs: { [k]: one } });
    }
  }
  return out;
}

/** Runs the RegistryPort rules R1-R5 against an instance. */
export async function checkRegistry(port: RegistryPort, f: RegistryFixtures = {}, c = new Checks()): Promise<Checks> {
  if (!c.expect('R1', typeof port?.list === 'function' && typeof port.get === 'function', 'list and get must be functions')) return c;
  const all = await c.attempt('R1', 'list', () => port.list());
  if (!all) return c;
  if (!c.expect('R1', Array.isArray(all), 'list must resolve to an array')) return c;
  all.forEach((e, i) => {
    const problems = entryProblems(e);
    c.all('R1', problems.filter((p) => !p.startsWith('trust') && !p.startsWith('ext')), `entry[${i}]`);
    c.all('R4', problems.filter((p) => p.startsWith('trust')), `entry[${i}]`);
    c.all('R5', problems.filter((p) => p.startsWith('ext')), `entry[${i}]`);
  });
  const ids = all.map((e) => e.id);
  c.expect('R1', new Set(ids).size === ids.length, `list must not repeat an id: ${ids.join(', ')}`);
  if (f.ids) c.expect('R1', isDeepStrictEqual([...ids].sort(), [...f.ids].sort()), `list returned ${JSON.stringify(ids)}, expected ${JSON.stringify(f.ids)}`);

  // R2: get agrees with list; an unknown id is undefined.
  for (const e of all) {
    const got = await c.attempt('R2', `get ${e.id}`, () => port.get(e.id));
    c.expect('R2', isDeepStrictEqual(got, e), `get("${e.id}") must return the entry list returns`);
  }
  for (const id of [uniqueId('missing'), 'constructor', '__proto__']) {
    if (ids.includes(id)) continue;
    c.expect('R2', (await c.attempt('R2', `get ${id}`, () => port.get(id))) === undefined, `get("${id}") of an unknown id must be undefined`);
  }

  // R3: filters behave as the spec says, and are not changed.
  for (const filter of [...derivedFilters(all), ...(f.filters ?? [])]) {
    const frozen = deepFreeze(structuredClone(filter));
    const got = await c.attempt('R3', `list ${JSON.stringify(filter)}`, () => port.list(frozen));
    if (!got) continue;
    const expected = all.filter((e) => specMatches(e, filter)).map((e) => e.id).sort();
    c.expect('R3', isDeepStrictEqual(got.map((e) => e.id).sort(), expected), `list(${JSON.stringify(filter)}) returned ${JSON.stringify(got.map((e) => e.id))}, expected ${JSON.stringify(expected)}`);
  }

  // R4: trust is an object of booleans (checked above on every entry).
  c.rule('R4');
  c.rule('R5');
  return c;
}

// Router ------------------------------------------------------------------------------------------------------------

export interface RouterCase {
  input: RunInput;
  /** Default: the sample entries. */
  candidates?: AgentEntry[];
  /** The member the router must choose; `null` for nobody. */
  expect?: string | null;
}

export interface RouterFixtures {
  /** Questions to ask besides the suite's own; with `expect`, the router's rules table. */
  cases?: RouterCase[];
}

/** Freezes a value and everything in it, so a router that changes its input throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** A caller whose `credential` cannot be read without the suite knowing. */
function trappedCaller(onRead: () => void): Caller {
  const caller: Caller = { id: 'conformance-user', kind: 'user', roles: ['staff'], scopes: [] };
  return new Proxy(deepFreeze(caller), {
    get(target, key, receiver) {
      if (key === 'credential') onRead();
      return Reflect.get(target, key, receiver);
    },
  });
}

/** Runs the AgentRouterPort rules A1-A5 against an instance. */
export async function checkRouter(port: AgentRouterPort, f: RouterFixtures = {}, c = new Checks()): Promise<Checks> {
  if (!c.expect('A1', typeof port?.route === 'function', 'route must be a function')) return c;
  const cases: RouterCase[] = [
    { input: 'hello' },
    { input: 'I need a refund for my last invoice' },
    { input: 'how do I set up the product' },
    { input: { text: 'invoice setup' } },
    { input: 'hello', candidates: [] },
    ...(f.cases ?? []),
  ];
  let credentialRead = false;
  for (const [i, routeCase] of cases.entries()) {
    const candidates = structuredClone(routeCase.candidates ?? [...SAMPLE_ENTRIES]);
    const caller = trappedCaller(() => { credentialRead = true; });
    const question: RouteQuestion = deepFreeze({ input: structuredClone(routeCase.input), candidates, caller });
    const snapshot = JSON.stringify({ input: question.input, candidates });
    const ctx: RunContext = deepFreeze({ runId: 'conformance-run', system: 'conformance', caller });
    const label = `case[${i}] ${JSON.stringify(routeCase.input)}`;
    const decision = await c.attempt('A3', `${label}: route (frozen question)`, () => port.route(question, ctx));
    c.expect('A3', JSON.stringify({ input: question.input, candidates }) === snapshot, `${label}: route must not change the question`);
    if (decision === undefined) continue;
    const ids = candidates.map((e) => e.id);
    if (!c.expect('A1', !!decision && typeof decision === 'object', `${label}: the decision must be an object`)) continue;
    c.expect('A1', decision.member === undefined || ids.includes(decision.member), `${label}: chose "${decision.member}", which is not a candidate`);
    c.expect('A1', decision.failed === undefined, `${label}: failed is set by the core, never by a router`);
    if (decision.ranked !== undefined) {
      const ranked = decision.ranked;
      const ok = Array.isArray(ranked) && ranked.every((r) => ids.includes(r.member) && typeof r.score === 'number' && Number.isFinite(r.score));
      c.expect('A2', ok, `${label}: ranked must list only candidates, each with a finite score`);
      if (Array.isArray(ranked)) c.expect('A2', new Set(ranked.map((r) => r.member)).size === ranked.length, `${label}: ranked must not repeat a member`);
      if (Array.isArray(ranked) && decision.member !== undefined && ranked.length) c.expect('A2', ranked.some((r) => r.member === decision.member), `${label}: the chosen member must be in ranked`);
    } else c.rule('A2');
    c.expect('A5', decision.reason === undefined || typeof decision.reason === 'string', `${label}: reason must be a string`);
    if (!ids.length) c.expect('A5', decision.member === undefined, `${label}: with no candidates no member can be chosen`);
    if (routeCase.expect !== undefined) c.expect('A5', (decision.member ?? null) === routeCase.expect, `${label}: chose ${JSON.stringify(decision.member ?? null)}, expected ${JSON.stringify(routeCase.expect)}`);
  }
  c.expect('A4', !credentialRead, 'route must never read the caller\'s credential');
  return c;
}
