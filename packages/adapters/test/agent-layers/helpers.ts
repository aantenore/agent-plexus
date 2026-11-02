import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordingTelemetry, type ComposeOptions, type Stack, type TelemetryRecord } from '@agent-layers/core';
import { assemble, resolveConfig, type Host, type System, type TopologySpec } from '@agent-plexus/core';
import { hostFromStack, openStack, type StackHostOptions } from '../../src/agent-layers/index.ts';

export const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface Recorded {
  records: TelemetryRecord[];
  compose: ComposeOptions;
}

/** Telemetry that keeps every record, to hand to `compose`. */
export function recorder(): Recorded {
  const records: TelemetryRecord[] = [];
  return { records, compose: { telemetry: [recordingTelemetry((r) => records.push(r))] } };
}

/** The fixture system config with its own topology and host, resolved. */
export async function plexusConfig(topology: TopologySpec | string[], extra: Record<string, unknown> = {}) {
  const raw = JSON.parse(await readFile(join(fixtures, 'plexus.json'), 'utf8')) as Record<string, unknown>;
  const spec: TopologySpec = Array.isArray(topology) ? { kind: 'sequence', steps: topology } : topology;
  return resolveConfig({ ...raw, topology: spec, ...extra }, { cwd: fixtures });
}

export interface Fixture {
  stack: Stack;
  host: Host;
  records: TelemetryRecord[];
  system(topology: TopologySpec | string[]): Promise<System>;
}

/** The governed fixture stack, a host over it and a way to assemble systems with that host. */
export async function fixture(options: StackHostOptions & { profile?: string } = {}): Promise<Fixture> {
  const { profile, ...hostOptions } = options;
  const { records, compose } = recorder();
  const stack = await openStack({ config: './layers.json', ...(profile ? { profile } : {}) }, fixtures, compose);
  const host = hostFromStack(stack, hostOptions);
  return { stack, host, records, system: async (topology) => assemble(await plexusConfig(topology), { host, cwd: fixtures }) };
}

export const alice = { id: 'alice', kind: 'user', roles: ['staff'], scopes: [], credential: 'alice-secret-credential' } as const;
export const publicAlice = { id: 'alice', kind: 'user' as const, roles: ['staff'], scopes: [] };
