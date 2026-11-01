import type { Readable } from 'node:stream';

/** Everything a command touches outside its arguments, so tests can replace it. */
export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: Readable;
  out(text: string): void;
  err(text: string): void;
}

export const processIo = (): Io => ({
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
});

/** Wrong command line: ends a command with its usage and exit code 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** A problem with a file or a system the command was given: a message and exit code 1, without a stack trace. */
export class CliError extends Error {
  override name = 'CliError';
}
