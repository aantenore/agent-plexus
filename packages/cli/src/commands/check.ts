import { AdapterError, ConfigError, type Finding } from '@agent-plexus/core';
import type { Io } from '../io.ts';
import { openProject, type ProjectArgs } from '../project.ts';

const fail = (path: string, message: string): Finding => ({ severity: 'fail', path, message });

const line = (f: Finding): string => `${f.severity === 'fail' ? 'FAIL' : 'WARN'} ${f.path}: ${f.message}`;

/** Config problems carry their path already (`$.topology: ...`); a file problem gets the file. */
function configFindings(err: ConfigError): Finding[] {
  return err.errors.map((e) => (e.startsWith('$') ? fail(e.slice(0, e.indexOf(':')), e.slice(e.indexOf(':') + 2)) : fail(err.file ?? 'config', e)));
}

/** Loads and assembles the system, prints every finding and a summary; exit 1 on any FAIL. */
export async function check(io: Io, args: ProjectArgs): Promise<number> {
  let findings: Finding[];
  let header = '';
  try {
    const { config, system } = await openProject(io, args);
    header = `system ${config.name} · profile ${config.profile ?? 'base'} · tier ${config.tier}`;
    try {
      findings = await system.check();
    } finally {
      await system.close();
    }
  } catch (err) {
    if (err instanceof ConfigError) findings = configFindings(err);
    else if (err instanceof AdapterError) findings = [fail(err.where, err.message.slice(err.where.length + 2))];
    else throw err;
  }
  if (header) io.out(header);
  for (const f of findings) io.out(line(f));
  const failed = findings.filter((f) => f.severity === 'fail').length;
  const warned = findings.length - failed;
  io.out(failed ? `check failed: ${failed} FAIL, ${warned} WARN` : `check passed${warned ? `: ${warned} WARN` : ''}`);
  return failed ? 1 : 0;
}
