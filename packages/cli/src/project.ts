import { assemble, loadConfig, type ResolvedConfig, type System } from '@agent-plexus/core';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UsageError, type Io } from './io.ts';

export const DEFAULT_CONFIG = 'plexus.json';

/** The process's interrupt as the context of a run, a resume or a cancel: nothing without one. */
export const interrupt = (io: Io): { signal?: AbortSignal } => (io.signal ? { signal: io.signal } : {});

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
 * console lines off: commands print hops from the run record instead. A missing config file is a usage error that
 * names the path and how to get one.
 */
export async function openProject(io: Io, args: ProjectArgs): Promise<Project> {
  const file = resolve(io.cwd, args.config ?? DEFAULT_CONFIG);
  const missing = await stat(file).then(() => false, (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
  if (missing) throw new UsageError(`no config at ${file}: run \`agent-plexus init\` to create a starter, or pass --config <file>`);
  const config = await loadConfig(file, { ...(args.profile ? { profile: args.profile } : {}), env: io.env });
  const system = await assemble(config, { env: io.env, quiet: true });
  return { file, config, system };
}
