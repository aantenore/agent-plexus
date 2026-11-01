import type { AdapterDescriptor } from './adapter.ts';
import { adapterLimitFindings } from './adapter-config.ts';
import type { ResolvedConfig } from './config.ts';
import type { Host } from './hooks.ts';
import type { AgentEntry, TopologyKind } from './shapes.ts';
import { limitFindings } from './system-limits.ts';
import { topologyProblems, unsupportedKinds } from './topology-check.ts';

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
}

/**
 * The readiness gate. On a production tier: the host must not be a prototype, no adapter may be prototype-only, and
 * limits (the system's and each adapter's) must be bounded and in their safe ranges. On any tier: the topology must be valid, and with
 * `registry.requireSigned` every member must have a signed card or a pinned endpoint.
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
  if (input.registryError) out.push({ severity: 'fail', path: '$.ports.registry', message: `registry could not list its entries: ${input.registryError}` });
  for (const id of input.registryIds ?? []) {
    if (!Object.keys(config.members).includes(id)) out.push({ severity: 'fail', path: '$.ports.registry', message: `entry "${id}" is not a configured member` });
  }
  if (config.registry.requireSigned) {
    for (const e of input.entries) {
      if (!e.trust.signed && !e.trust.pinned) out.push({ severity: 'fail', path: `$.members.${e.id}`, message: `member "${e.id}" has neither a signed card nor a pinned endpoint (registry.requireSigned)` });
    }
  }
  return out;
}
