import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Io } from '../io.ts';
import { hopLine, resultText } from '../format.ts';
import { interrupt, openProject, type ProjectArgs } from '../project.ts';

export interface DevArgs extends ProjectArgs {
  quiet?: boolean;
}

/** Terminal loop: each line is one run of the system. `/exit`, end of input or the process's interrupt quits. */
export async function dev(io: Io, args: DevArgs): Promise<number> {
  const { config, system } = await openProject(io, args);
  const sessionId = `dev-${randomUUID()}`;
  io.err(`system ${config.name} · profile ${config.profile ?? 'base'} · tier ${config.tier}. One run per line, /exit to quit.`);
  const rl = createInterface({ input: io.stdin, terminal: false });
  // An interrupt while the loop waits for a line ends it; one during a run stops that run, and the loop ends after it.
  const stop = (): void => rl.close();
  io.signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === '/exit' || io.signal?.aborted) break;
      if (!line) continue;
      const result = await system.run(line, { sessionId, ...interrupt(io) });
      io.out(resultText(result));
      if (!args.quiet) for (const hop of result.record) io.err(hopLine(hop));
    }
  } finally {
    io.signal?.removeEventListener('abort', stop);
    rl.close();
    await system.close();
  }
  return 0;
}
