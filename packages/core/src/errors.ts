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
