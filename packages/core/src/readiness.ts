import type { AdapterDescriptor } from './adapter.ts';
import { adapterLimitFindings } from './adapter-config.ts';
import type { ResolvedConfig } from './config.ts';
import type { Host } from './hooks.ts';
import type { ExecutionPort } from './ports.ts';
import type { AgentEntry, TopologyKind } from './shapes.ts';
import { limitFindings } from './system-limits.ts';
import { membersIn, topologyProblems, unsupportedKinds } from './topology-check.ts';
import { walkTopology } from './topology-walk.ts';

export interface Finding {
  severity: 'warn' | 'fail';
  /** Config path or subject the finding is about. */
  path: string;
  message: string;
}

export interface ReadinessInput {
  config: ResolvedConfig;
  host: Host;
  /** Every adapter the system uses, with the config path it was configured at. */
  adapters: { path: string; descriptor: AdapterDescriptor; options: Record<string, unknown> }[];
  entries: AgentEntry[];
  topologyKinds: readonly TopologyKind[];
  routers: string[];
  /** Ids the registry lists, when it has been asked. */
  registryIds?: string[];
  /** Why the registry could not be listed, when it could not. */
  registryError?: string;
  /** Why the topology could not be bound, when it could not. */
  bindError?: string;
  /** The created execution port, to check what it implements; absent, those checks are skipped. */
  execution?: ExecutionPort;
}

const MEMBER_PATH = /^\$\.members\.(.+)$/;

/** What the members, the topology and the execution port need of each other: warnings, never failures. */
function capabilityFindings(input: ReadinessInput): Finding[] {
  const out: Finding[] = [];
  const members = new Map<string, ReadinessInput['adapters'][number]>();
  for (const a of input.adapters) {
    const id = MEMBER_PATH.exec(a.path)?.[1];
    if (id !== undefined && a.descriptor.fills === 'MemberPort') members.set(id, a);
  }
  for (const [id, a] of members) {
    const c = a.descriptor.capabilities ?? {};
    if (c.waits && !c.resume) out.push({ severity: 'warn', path: a.path, message: `adapter "${a.descriptor.name}" declares waits but not resume: a run waiting on member "${id}" cannot continue` });
  }
  const all = Object.keys(input.config.members);
  walkTopology(input.config.topology, (node, path) => {
    if (typeof node === 'string' || node.kind !== 'parallel' || node.join !== 'first') return;
    const racing = new Set(node.branches.flatMap((b) => membersIn(b, all)));
    for (const id of racing) {
      const a = members.get(id);
      const c = a?.descriptor.capabilities ?? {};
      if (a && c.checkpoint && !c.cancel) out.push({ severity: 'warn', path: '$.topology', message: `${path}: join "first" abandons the losing branches, and member "${id}" (adapter "${a.descriptor.name}") checkpoints remote work but declares no cancel: that work keeps running` });
    }
  });
  if (input.execution && typeof input.execution.read !== 'function') {
    const name = input.adapters.find((a) => a.path === '$.ports.execution')?.descriptor.name ?? input.config.ports.execution.adapter;
    out.push({ severity: 'warn', path: '$.ports.execution', message: `adapter "${name}" has no read: stored texts cannot be read back, so attribution cannot trace them and expectations on member outputs cannot be scored` });
  }
  return out;
}

/**
 * The readiness gate. On a production tier: the host must not be a prototype, no adapter may be prototype-only, and
 * limits (the system's and each adapter's) must be bounded and in their safe ranges. On any tier: the topology must be valid, with
 * `registry.requireSigned` every member must have a signed card or a pinned endpoint, and with `registry.requireListed`
 * the registry must list every member; a `route` or `handoff` node needs `ports.registry`. Warnings name deprecated
 * parts of the config that are ignored, and capabilities a member, the topology or the execution port lack.
 */
export function readinessFindings(input: ReadinessInput): Finding[] {
  const { config } = input;
  const out: Finding[] = [];
  if (config.tier === 'production') {
    if (input.host.tier !== 'production') {
      out.push({ severity: 'fail', path: '$.host', message: `host "${input.host.name}" is a prototype host; a production tier needs a real host` });
    }
    for (const a of input.adapters) {
      if (!a.descriptor.tiers.includes('production')) out.push({ severity: 'fail', path: a.path, message: `adapter "${a.descriptor.name}" is prototype-only and cannot be used on the production tier` });
      for (const f of adapterLimitFindings(Object.values(a.descriptor.limits ?? {}), a.options, a.path)) out.push({ severity: f.severity, path: f.path, message: f.message });
    }
    for (const f of limitFindings(config.limits)) out.push({ severity: f.severity, path: f.path, message: f.message });
  }
  // A bind failure that the core's own findings already explain (same node and kind) is not reported twice.
  const unsupported = unsupportedKinds(config.topology, input.topologyKinds);
  const explained = input.bindError !== undefined && unsupported.some((u) => input.bindError!.includes(u.path) && input.bindError!.includes(u.kind));
  if (input.bindError && !explained) out.push({ severity: 'fail', path: '$.topology', message: `topology could not be bound: ${input.bindError}` });
  for (const message of topologyProblems(config.topology, Object.keys(config.members), input.topologyKinds, input.routers)) {
    out.push({ severity: 'fail', path: '$.topology', message });
  }
  if (!config.ports.registry) {
    walkTopology(config.topology, (node, path) => {
      if (typeof node !== 'string' && (node.kind === 'route' || node.kind === 'handoff')) out.push({ severity: 'fail', path: '$.ports.registry', message: `${path}: a ${node.kind} node needs ports.registry to read its candidates` });
    });
  }
  if (input.registryError) out.push({ severity: 'fail', path: '$.ports.registry', message: `registry could not list its entries: ${input.registryError}` });
  for (const id of input.registryIds ?? []) {
    if (!Object.keys(config.members).includes(id)) out.push({ severity: 'fail', path: '$.ports.registry', message: `entry "${id}" is not a configured member` });
  }
  if (config.registry.requireListed) {
    if (!config.ports.registry) out.push({ severity: 'fail', path: '$.registry.requireListed', message: 'registry.requireListed needs ports.registry' });
    for (const id of Object.keys(config.members)) {
      if (input.registryIds && !input.registryIds.includes(id)) out.push({ severity: 'fail', path: `$.members.${id}`, message: `member "${id}" is not listed by the registry (registry.requireListed)` });
    }
  }
  if (config.registry.requireSigned) {
    for (const e of input.entries) {
      if (!e.trust.signed && !e.trust.pinned) out.push({ severity: 'fail', path: `$.members.${e.id}`, message: `member "${e.id}" has neither a signed card nor a pinned endpoint (registry.requireSigned)` });
    }
  }
  for (const d of config.deprecated ?? []) out.push({ severity: 'warn', path: d.path, message: d.message });
  out.push(...capabilityFindings(input));
  return out;
}
