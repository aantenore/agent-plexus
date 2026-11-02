/** Rules for the targets the member may talk to, and bounded, redirect-free reads of the documents it fetches. */

/** Raised for a target or a card the rules refuse. The message is fixed text: it never carries remote content. */
export class Refused extends Error {
  override name = 'Refused';
}

function privateV4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Loopback, private, link-local and unspecified addresses, and `localhost` names, written literally in a URL. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h.replace(/^::ffff:/, ''));
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]));
  // IPv4-mapped IPv6 in the hex form the URL parser writes, e.g. `::ffff:7f00:1`
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) return privateV4(parseInt(mapped[1]!, 16) >> 8, parseInt(mapped[1]!, 16) & 0xff);
  return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

export interface TargetRules {
  allowHttp: boolean;
  /** Origins the operator configured: only these may be private or loopback targets. */
  configured: ReadonlySet<string>;
}

/** A URL the member may send to: https (or loopback, or `allowHttp`), no credentials in it, private only if configured. */
export function checkTarget(raw: string, what: string, rules: TargetRules): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refused(`${what} is not a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (rules.allowHttp || isLoopback(url.hostname)))) throw new Refused(`${what} must use https`);
  if (url.username || url.password) throw new Refused(`${what} must not carry credentials`);
  if (isPrivateHost(url.hostname) && !rules.configured.has(url.origin)) throw new Refused(`${what} is a private address that is not configured`);
  return url;
}

/** Whether a card may point at `target`: its own origin, or an entry of `allowed` (an origin or a URL prefix). */
export function endpointAllowed(target: URL, cardUrl: URL, allowed: readonly string[]): boolean {
  if (target.origin === cardUrl.origin) return true;
  return allowed.some((e) => {
    const entry = new URL(e);
    const prefix = entry.href.endsWith('/') ? entry.href : `${entry.href}/`;
    return e === target.href || e === target.origin || (entry.origin === target.origin && (target.href === entry.href || target.href.startsWith(prefix)));
  });
}

/** The body of a response as text, refused once it passes `maxBytes`. */
export async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Refused('document is larger than the size limit');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Refused('document is larger than the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetches a JSON document without credentials and without following redirects; size bounded. */
export async function fetchDocument(url: URL, maxBytes: number, signal: AbortSignal | undefined): Promise<unknown> {
  const init: RequestInit = { headers: { accept: 'application/json' }, redirect: 'error', credentials: 'omit' };
  if (signal) init.signal = signal;
  const res = await fetch(url, init);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Refused('document could not be fetched');
  }
  const text = await readBounded(res, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Refused('document is not JSON');
  }
}

/**
 * `fetch` for the SDK transport: redirects are errors, the body of a failed response is dropped unread (so text a
 * remote side echoes, a credential for instance, never reaches an error), and the body of an ok response is read up to
 * `maxResponseBytes`.
 */
export function createTransportFetch(maxResponseBytes: number): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, { ...init, redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      return new Response(null, { status: res.status });
    }
    let text: string;
    try {
      text = await readBounded(res, maxResponseBytes);
    } catch (error) {
      if (error instanceof Refused) throw new Refused('remote agent answer is larger than the size limit');
      throw error;
    }
    return new Response(text, { status: res.status, headers: res.headers });
  };
}
