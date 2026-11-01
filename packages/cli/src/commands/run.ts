import type { Io } from '../io.ts';
import { hopLine, publicResult, resultText } from '../format.ts';
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
    const result = await system.run(args.text);
    if (args.json) {
      io.out(JSON.stringify(publicResult(result), null, 2));
    } else {
      io.out(resultText(result));
      if (!args.quiet) for (const hop of result.record) io.err(hopLine(hop));
    }
    return result.status === 'completed' ? 0 : 1;
  } finally {
    await system.close();
  }
}
