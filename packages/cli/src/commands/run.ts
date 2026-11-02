import type { SystemResult } from '@agent-plexus/core';
import type { Io } from '../io.ts';
import { hopLine, publicResult, resultText, resumeHint } from '../format.ts';
import { openProject, type ProjectArgs } from '../project.ts';

/** Exit code of a run that ended waiting for a reply: neither a success nor a failure. */
export const EXIT_WAITING = 3;

export interface RunArgs extends ProjectArgs {
  text: string;
  /** Run under this id instead of a generated one. */
  runId?: string;
  json?: boolean;
  quiet?: boolean;
}

/** One system run: the output on stdout, then one line per hop on stderr unless `quiet`. Exit as `printResult`. */
export async function run(io: Io, args: RunArgs): Promise<number> {
  const { system } = await openProject(io, args);
  try {
    return printResult(io, await system.run(args.text, args.runId !== undefined ? { runId: args.runId } : {}), args);
  } finally {
    await system.close();
  }
}

/**
 * Prints a result as `run` does: JSON, or the output, the hop lines and how to resume a waiting run. The exit code: 0
 * completed, 3 waiting, 1 otherwise.
 */
export function printResult(io: Io, result: SystemResult, args: { json?: boolean; quiet?: boolean }): number {
  if (args.json) {
    io.out(JSON.stringify(publicResult(result), null, 2));
  } else {
    io.out(resultText(result));
    if (!args.quiet) for (const hop of result.record) io.err(hopLine(hop));
    if (result.status === 'waiting') io.err(resumeHint(result));
  }
  if (result.status === 'completed') return 0;
  return result.status === 'waiting' ? EXIT_WAITING : 1;
}
