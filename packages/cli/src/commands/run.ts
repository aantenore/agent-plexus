import type { SystemResult } from '@agent-plexus/core';
import type { Io } from '../io.ts';
import { hopLine, publicResult, resultText, resumeHint } from '../format.ts';
import { openProject, type ProjectArgs } from '../project.ts';

export interface RunArgs extends ProjectArgs {
  text: string;
  json?: boolean;
  quiet?: boolean;
}

/** One system run: the output on stdout, then one line per hop on stderr unless `quiet`. Exit 1 unless it completed. */
export async function run(io: Io, args: RunArgs): Promise<number> {
  const { system } = await openProject(io, args);
  try {
    return printResult(io, await system.run(args.text), args);
  } finally {
    await system.close();
  }
}

/** Prints a result as `run` does: JSON, or the output, the hop lines and how to resume a waiting run. The exit code. */
export function printResult(io: Io, result: SystemResult, args: { json?: boolean; quiet?: boolean }): number {
  if (args.json) {
    io.out(JSON.stringify(publicResult(result), null, 2));
  } else {
    io.out(resultText(result));
    if (!args.quiet) for (const hop of result.record) io.err(hopLine(hop));
    if (result.status === 'waiting') io.err(resumeHint(result));
  }
  return result.status === 'completed' ? 0 : 1;
}
