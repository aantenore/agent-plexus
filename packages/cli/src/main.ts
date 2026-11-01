import { AdapterError, ConfigError } from '@agent-plexus/core';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { check } from './commands/check.ts';
import { dev } from './commands/dev.ts';
import { evaluate } from './commands/eval.ts';
import { run } from './commands/run.ts';
import { CliError, processIo, UsageError, type Io } from './io.ts';
import { DEFAULT_CONFIG } from './project.ts';

export { processIo, type Io } from './io.ts';

const HELP = `agent-plexus <command> [options]

  check                      load and assemble the system, print findings (FAIL, WARN), exit 1 on any FAIL
  run <text>                 one run of the system: the output, then one line per hop (--json, --quiet)
  dev                        terminal loop: each line is a run, /exit quits (--quiet)
  eval <cases.json>          run, score and attribute a file of cases, exit 1 when a case fails (--json)

Common options: --config <file> (default ${DEFAULT_CONFIG}), --profile <name>, --help (also per command)
Exit codes: 0 ok, 1 findings, failed runs or a bad system, 2 wrong command line`;

const COMMON = {
  config: { type: 'string' }, profile: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

interface Flags {
  config?: string;
  profile?: string;
  json?: boolean;
  quiet?: boolean;
  help?: boolean;
}

interface Command {
  usage: string;
  help: string;
  options: ParseArgsOptionsConfig;
  exec(io: Io, flags: Flags, positionals: string[]): Promise<number>;
}

const project = (f: Flags) => ({ ...(f.config ? { config: f.config } : {}), ...(f.profile ? { profile: f.profile } : {}) });
const flag = (f: Flags, name: 'json' | 'quiet') => (f[name] ? { [name]: true } : {});

function noArgs(positionals: string[]): void {
  if (positionals.length) throw new UsageError('takes no arguments');
}

/** All arguments joined, so a request needs no quotes. */
function textOf(positionals: string[]): string {
  if (!positionals.length) throw new UsageError('expected <text>');
  return positionals.join(' ');
}

function fileOf(positionals: string[]): string {
  if (positionals.length !== 1) throw new UsageError('expected <cases.json>');
  return positionals[0] as string;
}

const COMMANDS: Record<string, Command> = {
  check: {
    usage: 'agent-plexus check [--config <file>] [--profile <name>]',
    help: `Loads the config, assembles the system with its adapters and applies the readiness gate of the profile's tier.
Prints one line per finding (FAIL or WARN, config path, message) and a summary. Config errors, adapters that cannot
be loaded and invalid topologies are FAIL findings. Exit 1 on any FAIL.`,
    options: COMMON,
    exec: (io, f, pos) => { noArgs(pos); return check(io, project(f)); },
  },
  run: {
    usage: 'agent-plexus run <text> [--config <file>] [--profile <name>] [--json] [--quiet]',
    help: `One run of the system with the given text. Prints the output, then one line per hop on stderr:
<member> <status> <code?> <ms>ms. Exit 1 unless the run completed.
  --quiet   no hop lines
  --json    print the SystemResult as JSON: the output and the hop record (keys, never texts)`,
    options: { ...COMMON, json: { type: 'boolean' }, quiet: { type: 'boolean' } },
    exec: (io, f, pos) => run(io, { ...project(f), text: textOf(pos), ...flag(f, 'json'), ...flag(f, 'quiet') }),
  },
  dev: {
    usage: 'agent-plexus dev [--config <file>] [--profile <name>] [--quiet]',
    help: `Terminal loop: every line is one run of the system, with the output and hop lines of "run". /exit or end of input quits.
  --quiet   no hop lines`,
    options: { ...COMMON, quiet: { type: 'boolean' } },
    exec: (io, f, pos) => { noArgs(pos); return dev(io, { ...project(f), ...flag(f, 'quiet') }); },
  },
  eval: {
    usage: 'agent-plexus eval <cases.json> [--config <file>] [--profile <name>] [--json]',
    help: `Runs every case of the file (an array of { id, input, expected?, tags? }), scores it through the system and, when a
score is below 1 or the run did not complete, attributes it: layer, member, member layer, confidence, evidence.
Exit 1 when any case fails.
  --json    machine output: counts and, per case, status, output, scores and attributions`,
    options: { ...COMMON, json: { type: 'boolean' } },
    exec: (io, f, pos) => evaluate(io, { ...project(f), cases: fileOf(pos), ...flag(f, 'json') }),
  },
};

/** Runs one command. Resolves to the exit code; never calls process.exit. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') { io.out(HELP); return 0; }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) { io.err(`agent-plexus: unknown command "${name}"\n\n${HELP}`); return 2; }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: command.options, allowPositionals: true, strict: true });
    const flags = values as Flags;
    if (flags.help) { io.out(`${command.usage}\n\n${command.help}`); return 0; }
    return await command.exec(io, flags, positionals);
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`agent-plexus ${name}: ${(err as Error).message}\nusage: ${command.usage}`);
      return 2;
    }
    if (err instanceof CliError || err instanceof ConfigError || err instanceof AdapterError) {
      io.err(`agent-plexus ${name}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
