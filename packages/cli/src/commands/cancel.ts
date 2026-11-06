import type { Io } from '../io.ts';
import { publicResult, resultText } from '../format.ts';
import { interrupt, openProject, type ProjectArgs } from '../project.ts';

export interface CancelArgs extends ProjectArgs {
  runId: string;
  reason?: string;
  json?: boolean;
}

/**
 * Cancels a run that is not over: prints `cancelled <runId>` (or the refusal, as `run` prints a result) and exits 0
 * when the run is cancelled, 1 otherwise.
 */
export async function cancel(io: Io, args: CancelArgs): Promise<number> {
  const { system } = await openProject(io, args);
  try {
    const result = await system.cancel(args.runId, { ...interrupt(io), ...(args.reason !== undefined ? { reason: args.reason } : {}) });
    const done = result.status === 'stopped' && result.reason?.code === 'cancelled';
    io.out(args.json ? JSON.stringify(publicResult(result), null, 2) : done ? `cancelled ${result.runId}` : resultText(result));
    return done ? 0 : 1;
  } finally {
    await system.close();
  }
}
