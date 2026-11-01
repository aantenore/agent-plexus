import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Io } from '../src/io.ts';

export const EXAMPLE = fileURLToPath(new URL('../../../examples/offline/', import.meta.url));
export const CONFIG = `${EXAMPLE}plexus.json`;
export const CASES = `${EXAMPLE}cases.json`;

/** An Io that records what is written; `stdin` is what `dev` reads. */
export function captureIo(cwd = EXAMPLE, input?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stdin = new PassThrough();
  if (input !== undefined) stdin.end(input);
  const io: Io = { cwd, env: {}, stdin, out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}
