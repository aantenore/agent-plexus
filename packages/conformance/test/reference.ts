/** Small, correct implementations of each port: the suites must pass on them, and catch each defect added to them. */
import {
  defineAdapter, inputText, PORT_VERSIONS,
  type AgentEntry, type AgentRouterPort, type Attribution, type AttributionPort, type Execution, type ExecutionPort, type MemberPort,
  type MemberResult, type RegistryPort, type RunInput, type RunScope, type TopologyNode, type TopologyPort, type TopologySpec,
} from '@agent-plexus/core';
import { SAMPLE_ENTRIES, specMatches } from '../src/index.ts';

type Json = string | undefined;
const save = (v: unknown): Json => JSON.stringify(v);
const load = (j: Json): unknown => (j === undefined ? undefined : JSON.parse(j));

interface Run {
  steps: Map<string, Json>;
  inflight: Map<string, Promise<unknown>>;
  waits: Map<string, Json>;
  signals: Map<string, Json>;
  pending: Map<string, ((v: Json) => void)[]>;
  kept: Map<string, Json>;
  texts: string[];
}

export function referenceExecution(): ExecutionPort {
  const runs = new Map<string, Run>();
  const settle = (run: Run, name: string, value: Json) => {
    if (run.waits.has(name)) return;
    run.waits.set(name, value);
    for (const resolve of run.pending.get(name) ?? []) resolve(value);
    run.pending.delete(name);
  };
  const execution = (key: string, run: Run): Execution => ({
    runKey: key,
    step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (run.steps.has(name)) return Promise.resolve(load(run.steps.get(name)) as T);
      const running = run.inflight.get(name);
      if (running) return running as Promise<T>;
      const call = (async () => {
        const json = save(await fn());
        run.steps.set(name, json);
        return load(json);
      })().finally(() => run.inflight.delete(name));
      run.inflight.set(name, call);
      return call as Promise<T>;
    },
    wait(name, untilAt) {
      if (run.waits.has(name)) return Promise.resolve(load(run.waits.get(name)));
      const until = Date.parse(untilAt);
      if (Number.isNaN(until)) return Promise.reject(new TypeError('untilAt is not a date'));
      if (run.signals.has(name)) {
        const early = run.signals.get(name);
        run.signals.delete(name);
        settle(run, name, early);
        return Promise.resolve(load(early));
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(run, name, undefined), Math.max(0, until - Date.now()));
        timer.unref();
        run.pending.set(name, [...(run.pending.get(name) ?? []), (v) => { clearTimeout(timer); resolve(load(v)); }]);
      });
    },
    async put(text) {
      run.texts.push(text);
      return `${key}:t${run.texts.length}`;
    },
    async remember(k, value) {
      if (!k) throw new TypeError('empty key');
      run.kept.set(k, save(value));
    },
    async recall(k) {
      return load(run.kept.get(k));
    },
    async end() {},
  });
  return {
    name: 'execution',
    async begin(key) {
      let run = runs.get(key);
      if (!run) runs.set(key, (run = { steps: new Map(), inflight: new Map(), waits: new Map(), signals: new Map(), pending: new Map(), kept: new Map(), texts: [] }));
      return execution(key, run);
    },
    async signal(key, name, value) {
      const run = runs.get(key);
      if (!run) throw new Error('unknown run');
      if (run.waits.has(name) || run.signals.has(name)) return false;
      if (run.pending.has(name)) settle(run, name, save(value));
      else run.signals.set(name, save(value));
      return true;
    },
    async read(k) {
      const at = k.lastIndexOf(':t');
      return runs.get(k.slice(0, at))?.texts[Number(k.slice(at + 2)) - 1];
    },
  };
}

/** Sequence and route only. */
export function referenceTopology(): TopologyPort {
  const walk = async (scope: RunScope, node: TopologyNode, path: string, input: RunInput): Promise<MemberResult> => {
    if (typeof node === 'string') return (await scope.call(node, input, { node: path })).result;
    const own = node.input === 'original' ? scope.input : input;
    if (node.kind === 'sequence') {
      let last: MemberResult = { status: 'completed', output: inputText(own) };
      let current = own;
      for (const [i, step] of node.steps.entries()) {
        last = await walk(scope, step, `${path}.steps[${i}]`, current);
        if (last.status !== 'completed') return last;
        current = last.output;
      }
      return last;
    }
    if (node.kind === 'route') {
      const decision = await scope.route({ input: own, candidates: node.candidates, node: path });
      if (decision.member) return (await scope.call(decision.member, own, { node: path, route: { member: decision.member } })).result;
      if (node.fallback !== undefined) return walk(scope, node.fallback, `${path}.fallback`, own);
      if (decision.failed) return { status: 'failed', output: '', reason: { code: 'error', layer: 'routing' } };
      return { status: 'stopped', output: '', reason: { code: 'rejected', layer: 'routing' } };
    }
    throw new TypeError(`unsupported kind ${node.kind}`);
  };
  const check = (node: TopologyNode, path: string): void => {
    if (typeof node === 'string') return;
    if (node.kind !== 'sequence' && node.kind !== 'route') throw new TypeError(`node "${path}" has kind "${node.kind}", which is not supported`);
    if (node.kind === 'sequence') node.steps.forEach((s, i) => check(s, `${path}.steps[${i}]`));
    if (node.kind === 'route' && node.fallback !== undefined) check(node.fallback, `${path}.fallback`);
  };
  return {
    name: 'topology',
    kinds: ['sequence', 'route'],
    bind(spec: TopologySpec) {
      check(spec, 'root');
      return { run: (input, scope) => walk(scope, spec, 'root', input) };
    },
  };
}

export function referenceMember(id = 'echo'): MemberPort {
  return {
    name: id,
    describe: async () => ({ id, name: id, description: '', skills: [], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } }),
    async invoke(input, ctx) {
      if (ctx.signal?.aborted) return { status: 'stopped', output: '', reason: { code: 'aborted', layer: 'member' } };
      return { status: 'completed', output: `echo:${inputText(input)}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

export function referenceRegistry(entries: readonly AgentEntry[] = SAMPLE_ENTRIES): RegistryPort {
  return {
    name: 'registry',
    list: async (filter) => structuredClone(entries.filter((e) => !filter || specMatches(e, filter))),
    get: async (id) => structuredClone(entries.find((e) => e.id === id)),
  };
}

export function referenceRouter(): AgentRouterPort {
  return {
    name: 'router',
    async route(question) {
      const text = inputText(question.input).toLowerCase();
      const ranked = question.candidates.map((c) => ({ member: c.id, score: c.skills.some((s) => s.tags.some((t) => text.includes(t))) ? 1 : 0 }));
      const best = ranked.find((r) => r.score > 0);
      return best ? { member: best.member, ranked } : {};
    },
  };
}

const NOT_FAILURES = ['needs_input', 'needs_auth', 'aborted'];

export function referenceAttribution(): AttributionPort {
  return {
    name: 'attribution',
    async attribute({ record }): Promise<Attribution[]> {
      const failed = record.filter((h) => !h.abandoned && h.status !== 'completed').at(-1);
      if (!failed || NOT_FAILURES.includes(String(failed.reason?.code))) return [];
      return [{ layer: failed.member ? 'member' : 'routing', ...(failed.member ? { member: failed.member } : {}), hopId: failed.hopId, confidence: 0.5, evidence: [`hop:${failed.hopId}`], by: 'reference' }];
    },
  };
}

/** Descriptors over the references, for checkAdapter and checkSystem. */
const descriptor = <F extends 'ExecutionPort' | 'TopologyPort' | 'MemberPort' | 'AttributionPort'>(fills: F, name: string, create: () => unknown, extra: Record<string, unknown> = {}) =>
  defineAdapter({
    fills, name, maps: { technology: 'reference' }, portVersion: PORT_VERSIONS[fills], tiers: ['prototype'],
    optionsSchema: { type: 'object', properties: {}, additionalProperties: false }, create: create as never, ...extra,
  });

export const executionAdapter = descriptor('ExecutionPort', 'reference-execution', referenceExecution);
export const topologyAdapter = descriptor('TopologyPort', 'reference-topology', referenceTopology);
export const memberAdapter = descriptor('MemberPort', 'reference-member', () => referenceMember(), { capabilities: { resume: false, cancel: false, checkpoint: false, waits: false } });
export const attributionAdapter = descriptor('AttributionPort', 'reference-attribution', referenceAttribution);
