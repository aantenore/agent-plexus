/**
 * System level: the adapter under test assembled with reference adapters and fake members, run end to end through
 * `assemble` (run, waiting, resume, a parallel run on a budget).
 */
import {
  assemble, defineAdapter, inputText, PORT_VERSIONS, resolveConfig,
  type AdapterDescriptor, type Fills, type MemberPort, type MemberResult, type RunInput, type System, type TopologySpec,
} from '@agent-plexus/core';
import { Checks, describeError, settle, type CheckLimits } from './check.ts';
import type { ConformanceReport } from './index.ts';
import { resultProblems } from './shapes.ts';

/** Fake member: `echo` answers `<id>(<input>)` and reports usage; `ask` waits for input once, then answers the reply. */
interface FakeMemberOptions { mode?: 'echo' | 'ask' }

const usage = { inputTokens: 10, outputTokens: 10 };

function fakeMember(id: string, mode: FakeMemberOptions['mode'] = 'echo'): MemberPort {
  return {
    name: id,
    describe: async () => ({ id, name: id, description: `${id} member`, skills: [{ id, name: id, description: '', tags: [id] }], endpoint: { protocol: 'function' }, trust: { signed: false, pinned: true } }),
    async invoke(input): Promise<MemberResult> {
      if (mode === 'ask') return { status: 'waiting', output: 'which invoice?', reason: { code: 'needs_input', layer: 'member' }, taskRef: `${id}-task`, usage, costUsd: 0.001 };
      return { status: 'completed', output: `${id}(${inputText(input)})`, usage, costUsd: 0.001 };
    },
    async resume(_taskRef, input): Promise<MemberResult> {
      if (input === undefined) return { status: 'waiting', output: 'which invoice?', reason: { code: 'needs_input', layer: 'member' }, taskRef: `${id}-task` };
      return { status: 'completed', output: `${id}(${inputText(input)})`, usage, costUsd: 0.001 };
    },
  };
}

/** The fake member adapter the system check builds its members from. */
export const conformanceMember = defineAdapter<'MemberPort', FakeMemberOptions>({
  fills: 'MemberPort',
  name: 'conformance-member',
  maps: { technology: 'conformance fake' },
  portVersion: PORT_VERSIONS.MemberPort,
  tiers: ['prototype'],
  capabilities: { resume: true, cancel: false, checkpoint: false, waits: true },
  optionsSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['echo', 'ask'] } }, additionalProperties: false },
  create: (options, ctx) => fakeMember(ctx.name, options.mode),
});

const PORT_KEY: Record<Exclude<Fills, 'MemberPort' | 'Host'>, string> = {
  RegistryPort: 'registry', AgentRouterPort: 'router', TopologyPort: 'topology', ExecutionPort: 'execution', AttributionPort: 'attribution',
};

export interface SystemFixtures {
  /** Reference adapters for the other ports: a topology, an execution and an attribution, unless the adapter fills them. */
  adapters: AdapterDescriptor<Fills, any>[];
  /** Options of the adapter under test. */
  options?: unknown;
  /** The execution is durable: the resume runs on a system assembled again, as after a restart. */
  durable?: boolean;
  /** MemberPort under test: an input it completes (default `"hello"`), and one that makes it wait. */
  input?: RunInput;
  wait?: RunInput;
  reply?: RunInput;
  /** Directory relative paths in options resolve against. */
  cwd?: string;
  limits?: CheckLimits;
}

/** Runs the system rules S1-S3: the adapter under test inside an assembled system. */
export async function checkSystem(d: AdapterDescriptor<Fills, any>, f: SystemFixtures): Promise<ConformanceReport> {
  const c = new Checks(f.limits, d, f.options);
  const all = [d, conformanceMember, ...f.adapters];
  const find = (fills: Fills) => (d.fills === fills ? d : f.adapters.find((a) => a.fills === fills));
  const ports: Record<string, unknown> = {};
  for (const [fills, key] of Object.entries(PORT_KEY) as [Fills, string][]) {
    const found = find(fills);
    if (found) ports[key] = { adapter: found.name, ...(found === d && f.options !== undefined ? { options: f.options } : {}) };
  }
  if (!ports.topology || !ports.execution || !ports.attribution) {
    c.fail('S1', 'a system needs a topology, an execution and an attribution adapter: pass reference adapters');
    return report(d, c);
  }
  const subject = d.fills === 'MemberPort';
  const members: Record<string, unknown> = {
    a: { adapter: 'conformance-member' },
    b: { adapter: 'conformance-member' },
    asker: { adapter: 'conformance-member', options: { mode: 'ask' } },
    ...(subject ? { subject: { adapter: d.name, ...(f.options !== undefined ? { options: f.options } : {}) } } : {}),
  };
  const raw = (topology: TopologySpec) => ({
    system: { name: 'conformance' },
    members,
    ports,
    ...(d.fills === 'Host' ? { host: { adapter: d.name, ...(f.options !== undefined ? { options: f.options } : {}) } } : {}),
    topology,
  });
  const resolveAdapter = async (fills: Fills, name: string) => {
    const found = all.find((a) => a.fills === fills && a.name === name);
    if (!found) throw new Error(`no ${fills} adapter named "${name}" among the reference adapters`);
    return found;
  };
  const cwd = f.cwd ?? process.cwd();
  const open = async (rule: string, topology: TopologySpec): Promise<System | undefined> =>
    c.attempt(rule, 'assemble', async () => assemble(resolveConfig(raw(topology), { cwd }), { cwd, resolveAdapter, quiet: true }));
  const valid = (rule: string, label: string, result: unknown) => c.all(rule, resultProblems(result), label);

  // S1: a run that waits, then a resume that answers it, on a system assembled again when the execution is durable.
  const waitsOn = subject && f.wait !== undefined ? 'subject' : 'asker';
  const steps: TopologySpec = { kind: 'sequence', steps: ['a', waitsOn] };
  let system = await open('S1', steps);
  if (system) {
    try {
      const input = subject && f.wait !== undefined ? f.wait : 'refund please';
      const first = await c.attempt('S1', 'run', () => system!.run(input));
      if (first) {
        valid('S1', 'run', first);
        c.expect('S1', first.status === 'waiting' && !!first.wait?.token, `the run must end waiting with a wait token, got ${first.status}`);
        if (first.status === 'waiting') {
          if (f.durable) {
            await system.close();
            system = await open('S1', steps);
          }
          const resumed = system && await c.attempt('S1', 'resume', () => system!.resume(first.runId, { input: f.reply ?? 'invoice 42', wait: first.wait!.token }));
          if (resumed) {
            valid('S1', 'resume', resumed);
            c.expect('S1', resumed.status === 'completed', `the resumed run must complete, got ${resumed.status}/${resumed.reason?.code} ${resumed.reason?.detail ?? ''}`);
            c.expect('S1', resumed.record.some((h) => h.replayed), 'the resumed run must replay the completed step');
          }
        }
      }
    } catch (err) {
      c.fail('S1', describeError(err));
    } finally {
      await system?.close().catch(() => {});
    }
  }

  // S2: a parallel run on a budget completes and spends within it. Skipped only when the topology adapter does not
  // run `parallel` (the readiness gate says so); any other outcome is judged.
  const parallel: TopologySpec = { kind: 'parallel', branches: subject ? ['a', 'subject'] : ['a', 'b'] };
  const assembled = await settle(() => assemble(resolveConfig(raw(parallel), { cwd }), { cwd, resolveAdapter, quiet: true }), c.timeoutMs);
  const second = 'value' in assembled ? assembled.value : undefined;
  if ('error' in assembled) c.fail('S2', `assemble: ${describeError(assembled.error)}`);
  if (second) {
    try {
      const findings = await c.attempt('S2', 'readiness', () => second.check()) ?? [];
      const noParallel = findings.some((x) => x.severity === 'fail' && x.path === '$.topology' && x.message.includes('kind "parallel" is not supported'));
      const input = subject ? (f.input ?? 'hello') : 'hello';
      const deadlineAt = new Date(Date.now() + 30_000).toISOString();
      const result = noParallel
        ? void c.skip('S2', 'parallel run: the topology adapter does not run parallel')
        : await c.attempt('S2', 'parallel run', () => second.run(input, { bounds: { deadlineAt, hops: 0, maxHops: 5, tokens: 10_000, costUsd: 1 } }));
      if (result) {
        valid('S2', 'parallel run', result);
        if (result.status !== 'completed') c.fail('S2', `the parallel run must complete, got ${result.status}/${result.reason?.code} ${result.reason?.detail ?? ''}`.trimEnd());
        else {
          c.expect('S2', result.record.length === 2, `a parallel run of two members must record two hops, got ${result.record.length}`);
          const spent = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
          c.expect('S2', spent <= 10_000 && (result.costUsd ?? 0) <= 1, 'a run must spend within its budget');
        }
      }
    } finally {
      await second.close().catch(() => {});
    }
  }

  // S3: the record of a failed run can be attributed without error.
  const third = await open('S3', { kind: 'sequence', steps: ['a', 'b'] });
  if (third) {
    try {
      const result = await c.attempt('S3', 'run', () => third.run('hello'));
      if (result) {
        const out = await c.attempt('S3', 'attribute', () => third.attribute({ ...result, status: 'failed', reason: { code: 'error', layer: 'member' } }));
        c.expect('S3', Array.isArray(out), 'attribute must resolve to a list');
      }
    } finally {
      await third.close().catch(() => {});
    }
  }
  return report(d, c);
}

const report = (d: AdapterDescriptor<Fills, any>, c: Checks): ConformanceReport => ({
  fills: d.fills, adapter: d.name, ok: c.failures.length === 0, failures: [...c.failures], skipped: [...c.skipped], warnings: [...c.warnings], rules: [...c.rules],
});
