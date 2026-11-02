import { AdapterError, ConfigError, type ResumeReply } from '@agent-plexus/core';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { check } from './commands/check.ts';
import { dev } from './commands/dev.ts';
import { evaluate } from './commands/eval.ts';
import { resume } from './commands/resume.ts';
import { run } from './commands/run.ts';
import { CliError, processIo, UsageError, type Io } from './io.ts';
import { DEFAULT_CONFIG } from './project.ts';

export { processIo, type Io } from './io.ts';

const HELP = `agent-plexus <command> [options]

  check                      load and assemble the system, print findings (FAIL, WARN), exit 1 on any FAIL
  run <text>                 one run of the system: the output, then one line per hop (--run-id <id>, --json, --quiet)
  resume <runId>             answer a waiting run and run it again (--input <text> | --approve | --deny [--reason <text>]) [--wait <token>]
  dev                        terminal loop: each line is a run, /exit quits (--quiet)
  eval <cases.json>          run, score and attribute a file of cases, exit 1 when a case fails (--json)

Common options: --config <file> (default ${DEFAULT_CONFIG}), --profile <name>, --help (also per command)
Exit codes: 0 ok, 1 findings, failed runs or a bad system, 2 wrong command line, 3 a run waiting for a reply (run, resume)`;

const COMMON = {
  config: { type: 'string' }, profile: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

interface Flags {
  config?: string;
  profile?: string;
  json?: boolean;
  quiet?: boolean;
  help?: boolean;
  input?: string;
  approve?: boolean;
  deny?: boolean;
  reason?: string;
  wait?: string;
  'run-id'?: string;
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

/** Longest run id the system accepts; a longer one would be replaced by a generated id. */
const MAX_RUN_ID = 128;

/** The run id `--run-id` asks for, if any: non-empty and at most 128 characters. */
function runIdFlag(f: Flags): { runId?: string } {
  const id = f['run-id'];
  if (id === undefined) return {};
  if (!id || id.length > MAX_RUN_ID) throw new UsageError(`--run-id needs an id of 1 to ${MAX_RUN_ID} characters`);
  return { runId: id };
}

function runIdOf(positionals: string[]): string {
  if (positionals.length !== 1) throw new UsageError('expected <runId>');
  return positionals[0] as string;
}

/** Exactly one of --input, --approve and --deny; --reason goes with an approval or a denial; --wait names the wait answered. */
function replyOf(f: Flags): ResumeReply {
  if ([f.input !== undefined, !!f.approve, !!f.deny].filter(Boolean).length !== 1) throw new UsageError('expected one of --input <text>, --approve, --deny');
  if (f.wait === '') throw new UsageError('--wait needs the token of the wait');
  const wait = f.wait !== undefined ? { wait: f.wait } : {};
  if (f.input !== undefined) {
    if (f.reason !== undefined) throw new UsageError('--reason goes with --approve or --deny');
    return { input: f.input, ...wait };
  }
  return { approved: !!f.approve, ...(f.reason !== undefined ? { reason: f.reason } : {}), ...wait };
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
    usage: 'agent-plexus run <text> [--run-id <id>] [--config <file>] [--profile <name>] [--json] [--quiet]',
    help: `One run of the system with the given text. Prints the output, then one line per hop on stderr:
<member> <status> <code?> <ms>ms. A waiting run ends with the "resume" command that answers it.
Exit 0 when the run completed, 3 when it waits for a reply, 1 otherwise.
  --run-id <id>   run under this id (1 to 128 characters) instead of a generated one; with the id of a run the
                  journal keeps, the run continues with the same input (completed steps replay)
  --quiet         no hop lines
  --json          print the SystemResult as JSON: the output and the hop record (keys, never texts)`,
    options: { ...COMMON, json: { type: 'boolean' }, quiet: { type: 'boolean' }, 'run-id': { type: 'string' } },
    exec: (io, f, pos) => run(io, { ...project(f), text: textOf(pos), ...runIdFlag(f), ...flag(f, 'json'), ...flag(f, 'quiet') }),
  },
  resume: {
    usage: 'agent-plexus resume <runId> (--input <text> | --approve | --deny [--reason <text>]) [--wait <token>] [--config <file>] [--profile <name>] [--json] [--quiet]',
    help: `Answers a run that ended waiting and runs it again under the same run id, with the input it started with.
Completed steps replay from the journal; the waiting call gets the reply. Output and exit codes as for "run":
0 completed, 3 waiting again, 1 otherwise.
  --input <text>    the input a waiting member asked for
  --approve         approve the call the host's gate asked about; --deny refuses it (--reason <text> goes with either)
  --wait <token>    the wait this reply answers, as the waiting run printed it: the resume fails when the run now
                    waits elsewhere, so a repeated or late reply cannot answer a later wait
  --quiet           no hop lines
  --json            print the SystemResult as JSON
The run must be in the journal: across processes this needs a durable execution adapter. An execution adapter that
keeps runs in the memory of one process cannot resume a run started by another "agent-plexus run".`,
    options: { ...COMMON, json: { type: 'boolean' }, quiet: { type: 'boolean' }, input: { type: 'string' }, approve: { type: 'boolean' }, deny: { type: 'boolean' }, reason: { type: 'string' }, wait: { type: 'string' } },
    exec: (io, f, pos) => resume(io, { ...project(f), runId: runIdOf(pos), reply: replyOf(f), ...flag(f, 'json'), ...flag(f, 'quiet') }),
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
