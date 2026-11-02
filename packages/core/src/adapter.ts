/** Adapter descriptors: how a package declares what it fills, for which tiers, with which options and limits. */
import type { Host, TelemetryHook } from './hooks.ts';
import type { Layer } from './layers.ts';
import type { LimitSpec } from './limits.ts';
import { PORT_VERSIONS, type AgentRouterPort, type AttributionPort, type ExecutionPort, type MemberPort, type PortName, type RegistryPort, type TopologyPort } from './ports.ts';
import type { AgentEntry } from './shapes.ts';
import { isPlainObject } from './util.ts';

export type Tier = 'prototype' | 'production';
export const TIERS: readonly Tier[] = ['prototype', 'production'];

/** What an adapter fills: one of the six ports, or the host hooks. */
export interface FillTypes {
  MemberPort: MemberPort;
  RegistryPort: RegistryPort;
  AgentRouterPort: AgentRouterPort;
  TopologyPort: TopologyPort;
  ExecutionPort: ExecutionPort;
  AttributionPort: AttributionPort;
  Host: Host;
}
export type Fills = keyof FillTypes;
export const FILLS: readonly Fills[] = [...(Object.keys(PORT_VERSIONS) as PortName[]), 'Host'];

export const LAYER_OF: Readonly<Record<PortName, Layer>> = {
  MemberPort: 'member',
  RegistryPort: 'registry',
  AgentRouterPort: 'routing',
  TopologyPort: 'topology',
  ExecutionPort: 'execution',
  AttributionPort: 'attribution',
};

/** A small JSON Schema subset, enough to validate adapter options without a dependency. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  oneOf?: JsonSchema[];
}

export interface AdapterContext {
  /** Name of the system being assembled. */
  system: string;
  /** Instance name: the member id for members, the port key otherwise. */
  name: string;
  /** Directory of the system config; relative paths in options resolve against it. */
  cwd: string;
  env: Record<string, string | undefined>;
  telemetry: TelemetryHook;
  /** Entries of the configured members, for registries. Call it when used, not inside `create`. */
  members?: () => Promise<AgentEntry[]>;
}

/**
 * What a member adapter can do beyond `describe` and `invoke`, declared so the readiness gate can warn about a system
 * that needs more: a member that `waits` needs `resume`; a member that `checkpoint`s remote work needs `cancel` where a
 * parallel `join: first` drops the losing branches.
 */
export interface MemberCapabilities {
  /** Continues remote work or answers a waiting call (`MemberPort.resume`). */
  resume?: boolean;
  /** Stops remote work (`MemberPort.cancel`). */
  cancel?: boolean;
  /** Journals the handle of remote work (`MemberCallContext.checkpoint`). */
  checkpoint?: boolean;
  /** Can end a call `waiting` for input. */
  waits?: boolean;
}
const CAPABILITIES: readonly (keyof MemberCapabilities)[] = ['resume', 'cancel', 'checkpoint', 'waits'];

/** What every descriptor has; `portVersion` depends on what it fills (see `AdapterDescriptor`). */
export interface AdapterDescriptorBase<F extends Fills = Fills, O = Record<string, unknown>> {
  fills: F;
  name: string;
  /** What the adapter maps: an open standard, or a technology's native API. */
  maps: { standard?: string; technology?: string };
  tiers: readonly Tier[];
  description?: string;
  optionsSchema?: JsonSchema;
  limits?: Readonly<Record<string, LimitSpec>>;
  /** MemberPort adapters only: what the member can do beyond `describe` and `invoke`. */
  capabilities?: MemberCapabilities;
  create(options: O, ctx: AdapterContext): FillTypes[F] | Promise<FillTypes[F]>;
}

/**
 * An adapter descriptor. `portVersion`, the port version implemented, is required for a port and optional for a host
 * (`fills: "Host"`), which implements no port; loading checks it all the same (`checkDescriptor`).
 */
export type AdapterDescriptor<F extends Fills = Fills, O = Record<string, unknown>> = AdapterDescriptorBase<F, O>
  & (F extends 'Host' ? { portVersion?: string } : { portVersion: string });

export function defineAdapter<F extends Fills, O = Record<string, unknown>>(d: AdapterDescriptor<F, O>): AdapterDescriptor<F, O> {
  if (!d?.name || !/^[a-z0-9][a-z0-9-]*$/.test(d.name)) throw new TypeError(`adapter "${String(d?.name)}": name must be lowercase kebab-case`);
  if (!d.tiers?.length) throw new TypeError(`adapter "${d.name}": tiers must not be empty`);
  if (typeof d.create !== 'function') throw new TypeError(`adapter "${d.name}": create must be a function`);
  return d;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether an adapter built for `adapterVersion` of a port works with the core's `coreVersion`: same major and, while
 * the major is 0, same minor (a 0.x minor bump may break, as in semver).
 */
export function compatiblePortVersion(adapterVersion: string, coreVersion: string): boolean {
  const a = SEMVER.exec(adapterVersion);
  const c = SEMVER.exec(coreVersion);
  if (!a || !c || a[1] !== c[1]) return false;
  return a[1] !== '0' || a[2] === c[2];
}

/**
 * Problems of a descriptor's shape, empty when it is sound: `fills` a known port or `Host`, a non-empty `name`, `maps`
 * naming a standard or a technology, `tiers` a non-empty subset of the tiers, an object `optionsSchema`, a semver
 * `portVersion` (required for ports) compatible with the core's, `capabilities` on member adapters only, `create` a
 * function.
 */
export function checkDescriptor(descriptor: unknown): string[] {
  if (!isPlainObject(descriptor)) return ['descriptor must be an object'];
  const d = descriptor as Partial<AdapterDescriptor> & Record<string, unknown>;
  const out: string[] = [];
  const fills = FILLS.includes(d.fills as Fills) ? (d.fills as Fills) : undefined;
  if (!fills) out.push(`fills must be one of ${FILLS.join(', ')}`);
  if (typeof d.name !== 'string' || !d.name) out.push('name must be a non-empty string');
  const maps = d.maps as Record<string, unknown> | undefined;
  if (!isPlainObject(maps) || ![maps.standard, maps.technology].some((m) => typeof m === 'string' && m)) out.push('maps must name a standard or a technology');
  if (!Array.isArray(d.tiers) || !d.tiers.length || d.tiers.some((t) => !TIERS.includes(t))) out.push(`tiers must be a non-empty subset of ${TIERS.join(', ')}`);
  if (d.optionsSchema !== undefined && !isPlainObject(d.optionsSchema)) out.push('optionsSchema must be an object');
  if (d.portVersion !== undefined && (typeof d.portVersion !== 'string' || !SEMVER.test(d.portVersion))) {
    out.push(`portVersion must be a semver version, got ${JSON.stringify(d.portVersion)}`);
  } else if (fills && fills !== 'Host') {
    const core = PORT_VERSIONS[fills];
    if (d.portVersion === undefined) out.push(`portVersion is required (the core implements ${fills} ${core})`);
    else if (!compatiblePortVersion(d.portVersion, core)) out.push(`implements ${fills} ${d.portVersion}, the core implements ${fills} ${core}`);
  }
  if (d.capabilities !== undefined) {
    if (fills !== 'MemberPort') out.push('capabilities are declared by MemberPort adapters only');
    else if (!isPlainObject(d.capabilities)) out.push('capabilities must be an object');
    else {
      for (const [k, v] of Object.entries(d.capabilities)) {
        if (!CAPABILITIES.includes(k as keyof MemberCapabilities)) out.push(`capabilities.${k}: unknown (known: ${CAPABILITIES.join(', ')})`);
        else if (typeof v !== 'boolean') out.push(`capabilities.${k}: must be a boolean`);
      }
    }
  }
  if (typeof d.create !== 'function') out.push('create must be a function');
  return out;
}
