import {
  checkDescriptor as coreDescriptorProblems, createAdapter, noopTelemetry,
  type AdapterContext, type AdapterDescriptor, type Fills, type FillTypes,
} from '@agent-plexus/core';
import { Checks, describeError, type CheckLimits } from './check.ts';
import { checkAttribution } from './suites/attribution.ts';
import { checkRegistry, checkRouter, SAMPLE_ENTRIES } from './suites/discovery.ts';
import { checkExecution } from './suites/execution.ts';
import { checkHost } from './suites/host.ts';
import { checkMember } from './suites/member.ts';
import { checkTopology } from './suites/topology.ts';

export { Checks, extProblems, extWarnings, type CheckLimits } from './check.ts';
export { attributionProblems, entryProblems, resultProblems } from './shapes.ts';
export { completed, DEFAULT_LIMITS, fakeScope, untilAborted, type FakeCall, type FakeMember, type FakeScope, type FakeScopeOptions } from './fake-scope.ts';
export { checkExecution, type ExecutionFixtures } from './suites/execution.ts';
export { checkTopology, TOPOLOGY_KINDS, type TopologyFixtures } from './suites/topology.ts';
export { CANARY_CREDENTIAL, checkMember, type MemberFixtures } from './suites/member.ts';
export { checkRegistry, checkRouter, deepFreeze, SAMPLE_ENTRIES, specMatches, type RegistryFixtures, type RouterCase, type RouterFixtures } from './suites/discovery.ts';
export { CANARY_TEXT, checkAttribution, hop, type AttributionCase, type AttributionFixtures } from './suites/attribution.ts';
export { checkHost, type HostFixtures } from './suites/host.ts';
export { checkSystem, type SystemFixtures } from './system.ts';

type Suite = (impl: any, fixtures: any, c: Checks) => Promise<Checks>;

/** A descriptor of any adapter, whatever its options type. */
export type AnyDescriptor = AdapterDescriptor<Fills, any>;

const SUITES: Record<Fills, Suite> = {
  ExecutionPort: checkExecution,
  TopologyPort: checkTopology,
  MemberPort: checkMember,
  RegistryPort: checkRegistry,
  AgentRouterPort: checkRouter,
  AttributionPort: checkAttribution,
  Host: checkHost,
};

export interface ConformanceReport {
  fills: Fills;
  adapter?: string;
  ok: boolean;
  /** One line per broken rule, starting with the rule id: `E3: ...`. */
  failures: string[];
  /** Checks that need a fixture or an operation the adapter does not have, with the rule id. */
  skipped: string[];
  /** Notes that fail no rule but should change (a deprecated form), with the rule id. */
  warnings: string[];
  /** Ids of the rules evaluated. */
  rules: string[];
}

/** The failures of the given rules: for a test that marks one known gap `todo`. */
export const failuresOf = (report: Pick<ConformanceReport, 'failures'>, ...rules: string[]): string[] =>
  report.failures.filter((f) => rules.some((r) => f.startsWith(`${r}: `)));

/** The failures of every rule but the given ones. */
export const failuresExcept = (report: Pick<ConformanceReport, 'failures'>, ...rules: string[]): string[] =>
  report.failures.filter((f) => !rules.some((r) => f.startsWith(`${r}: `)));

const reportOf = (fills: Fills, c: Checks, adapter?: string): ConformanceReport => ({
  fills, ...(adapter ? { adapter } : {}), ok: c.failures.length === 0, failures: [...c.failures], skipped: [...c.skipped], warnings: [...c.warnings], rules: [...c.rules],
});

/** Runs the suite of a port, or of the host hooks, on an instance. Never throws; failures are returned. */
export async function conformance<F extends Fills>(fills: F, impl: FillTypes[F], fixtures?: unknown, limits?: CheckLimits): Promise<ConformanceReport> {
  const c = new Checks(limits);
  await runSuite(fills, impl, fixtures, c);
  return reportOf(fills, c);
}

async function runSuite(fills: Fills, impl: unknown, fixtures: unknown, c: Checks): Promise<void> {
  const suite = SUITES[fills];
  if (!suite) return void c.fail('D1', `no conformance suite for ${String(fills)}`);
  if (!impl || typeof impl !== 'object') return void c.fail('D3', `${fills}: the instance must be an object`);
  await suite(impl, fixtures ?? {}, c).catch((err: unknown) => c.fail('D3', `suite crashed: ${describeError(err)}`));
}

/**
 * Descriptor problems: the core's own check (`fills`, `name`, `maps`, `tiers`, `portVersion`, `capabilities`), an
 * options schema, and every top-level limit described by the schema.
 */
export function checkDescriptor(d: AnyDescriptor): string[] {
  const out = coreDescriptorProblems(d);
  if (!d?.optionsSchema) out.push('optionsSchema is missing');
  const props = d?.optionsSchema?.properties ?? {};
  for (const limit of Object.values(d?.limits ?? {})) {
    const key = /^options\.(\w+)$/.exec(limit.path)?.[1];
    if (key && !Object.hasOwn(props, key)) out.push(`limit ${limit.path} is not in optionsSchema`);
  }
  return out;
}

export interface CheckAdapterOptions {
  /** Options the adapter is created with; validated against its schema and limits, as a system config would be. */
  options?: unknown;
  /** Fixtures of the port's suite. */
  fixtures?: unknown;
  /** Context of `create`; `members` defaults to the sample entries (registries list them). */
  ctx?: Partial<AdapterContext>;
  limits?: CheckLimits;
}

/**
 * Checks a descriptor (D1, D2), creates an instance from `options` the way `assemble` does (D3) and runs the suite of
 * what it fills. Closes the instance.
 */
export async function checkAdapter(d: AnyDescriptor, opts: CheckAdapterOptions = {}): Promise<ConformanceReport> {
  const c = new Checks(opts.limits, d, opts.options);
  c.all('D1', checkDescriptor(d).filter((p) => !p.startsWith('limit ')), 'descriptor');
  c.all('D2', checkDescriptor(d).filter((p) => p.startsWith('limit ')), 'descriptor');
  if (!d || typeof d.create !== 'function') return reportOf(d?.fills, c, d?.name);
  const ctx: AdapterContext = {
    system: 'conformance', name: d.fills === 'Host' ? 'host' : d.name, cwd: process.cwd(), env: process.env, telemetry: noopTelemetry,
    members: async () => structuredClone([...SAMPLE_ENTRIES]),
    ...opts.ctx,
  };
  let instance: unknown;
  try {
    const created = await createAdapter(async () => d, d.fills, { adapter: d.name, options: (opts.options ?? {}) as Record<string, unknown> }, ctx, `conformance.${d.name}`);
    instance = created.instance;
    c.rule('D3');
  } catch (err) {
    c.fail('D3', `create: ${describeError(err)}`);
  }
  if (instance) {
    await runSuite(d.fills, instance, opts.fixtures, c);
    await (instance as { close?(): Promise<void> }).close?.().catch(() => {});
  }
  return reportOf(d.fills, c, d.name);
}
