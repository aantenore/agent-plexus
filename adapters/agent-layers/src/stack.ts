import { resolve } from 'node:path';
import { compose, loadConfig, type ComposeOptions, type Stack } from '@agent-layers/core';

export interface StackOptions {
  /** Path of the agent-layers config, relative to the directory of the plexus config. */
  config: string;
  profile?: string;
}

/** Loads an agent-layers config and composes its stack. */
export async function openStack(options: StackOptions, cwd: string, composeOptions?: ComposeOptions): Promise<Stack> {
  const config = await loadConfig(resolve(cwd, options.config), options.profile ? { profile: options.profile } : {});
  return compose(config, composeOptions);
}
