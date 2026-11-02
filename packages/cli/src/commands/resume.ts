import type { ResumeReply } from '@agent-plexus/core';
import type { Io } from '../io.ts';
import { openProject, type ProjectArgs } from '../project.ts';
import { printResult } from './run.ts';

export interface ResumeArgs extends ProjectArgs {
  runId: string;
  reply: ResumeReply;
  json?: boolean;
  quiet?: boolean;
}

/** Answers a waiting run and runs it again under its run id. Output and exit code as for `run`. */
export async function resume(io: Io, args: ResumeArgs): Promise<number> {
  const { system } = await openProject(io, args);
  try {
    return printResult(io, await system.resume(args.runId, args.reply), args);
  } finally {
    await system.close();
  }
}
