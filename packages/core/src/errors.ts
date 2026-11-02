/** Invalid system configuration. `errors` lists every problem found, with its path. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly errors: string[];
  readonly file: string | undefined;
  constructor(errors: string[], file?: string) {
    super(`${file ? `${file}: ` : ''}invalid configuration\n  ${errors.join('\n  ')}`);
    this.errors = errors;
    this.file = file;
  }
}

/** An adapter could not be found, loaded or created. The message names the config path and the adapter. */
export class AdapterError extends Error {
  override name = 'AdapterError';
  readonly where: string;
  readonly adapter: string;
  constructor(where: string, adapter: string, message: string, options?: ErrorOptions) {
    super(`${where}: adapter "${adapter}" ${message}`, options);
    this.where = where;
    this.adapter = adapter;
  }
}

/** Code of the error an ExecutionPort's `begin` rejects with while another invocation holds the run. */
export const RUN_BUSY = 'RUN_BUSY';

/** `begin` found the run held by another invocation, in this process or another. Recognised by its `code`. */
export class RunBusyError extends Error {
  override name = 'RunBusyError';
  readonly code = RUN_BUSY;
  readonly runKey: string;
  constructor(runKey: string, message = `run "${runKey}" is held by another invocation`) {
    super(message);
    this.runKey = runKey;
  }
}

/** Whether an error says the run is held by another invocation: a `RunBusyError` or any error with code `RUN_BUSY`. */
export const isRunBusy = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === RUN_BUSY;
