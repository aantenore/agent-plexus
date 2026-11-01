import { assemble, loadConfig, type ResolvedConfig, type System } from '@agent-plexus/core';
import { resolve } from 'node:path';
import type { Io } from './io.ts';

export const DEFAULT_CONFIG = 'plexus.json';

export interface ProjectArgs {
  config?: string;
  profile?: string;
}

export interface Project {
  file: string;
  config: ResolvedConfig;
  system: System;
}

/**
 * Loads the config file and assembles the system. Without a configured host the prototype host is used with its
 * console lines off: commands print hops from the run record instead.
 */
export async function openProject(io: Io, args: ProjectArgs): Promise<Project> {
  const file = resolve(io.cwd, args.config ?? DEFAULT_CONFIG);
  const config = await loadConfig(file, { ...(args.profile ? { profile: args.profile } : {}), env: io.env });
  const system = await assemble(config, { env: io.env, quiet: true });
  return { file, config, system };
}
