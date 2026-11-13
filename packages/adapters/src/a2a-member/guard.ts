/** Rules for the targets the member may talk to, and bounded, redirect-free reads of the documents it fetches. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/** Raised for a target or a card the rules refuse. The message is fixed text: it never carries remote content. */
export class Refused extends Error {
  override name = 'Refused';
}

function privateV4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Loopback, private, link-local and unspecified addresses, and `localhost` names, as a URL writes them or as DNS gives them. */
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

/** One address a host name resolves to. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves a host name to all its addresses; `family` is 4 or 6 when the connection asks for one of them. */
export type Resolver = (hostname: string, family?: number) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = (hostname, family) => dnsLookup(hostname, { all: true, ...(family ? { family } : {}) });

export interface TargetRules {
  allowHttp: boolean;
  /** Origins the operator configured: only these may be private or loopback targets. */
  configured: ReadonlySet<string>;
  /** Configured host names may resolve to private addresses (default false). */
  allowPrivateDns?: boolean;
  /** How host names are resolved when a connection opens; default: the system resolver (`dns.lookup`). */
  resolve?: Resolver;
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

/**
 * The addresses `url`'s host name resolves to, refused when any of them is private. A host name passes `checkTarget`
 * as written, so this is where a public name that points inside is caught. A configured origin may resolve to a
 * private address when its name already says so (`localhost`) or with `allowPrivateDns`.
 */
export async function resolveTarget(url: URL, rules: TargetRules, family?: number): Promise<ResolvedAddress[]> {
  const addresses = await (rules.resolve ?? systemResolver)(url.hostname.replace(/^\[|\]$/g, ''), family);
  if (addresses.length === 0) throw new Refused('the host name has no address');
  const mayBePrivate = rules.configured.has(url.origin) && (rules.allowPrivateDns === true || isPrivateHost(url.hostname));
  if (!mayBePrivate && addresses.some((a) => isPrivateHost(a.address))) {
    throw new Refused('the host name resolves to a private address; set allowPrivateDns to allow it for configured origins');
  }
  return addresses;
}

/**
 * The `lookup` of one connection to `url`: the socket connects only to addresses `resolveTarget` let through, so the
 * address that was checked is the address that is used, with no second resolution in between.
 */
function guardedLookup(url: URL, rules: TargetRules): LookupFunction {
  return (_hostname, options, callback) => {
    resolveTarget(url, rules, options.family === 4 || options.family === 6 ? options.family : undefined).then(
      (addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0),
    );
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function toResponse(res: IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
  }
  if (method === 'HEAD' || status === 204 || status === 304) {
    res.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers });
}

/**
 * A `fetch` whose connections resolve host names through the target rules (`resolveTarget`). The global `fetch` takes
 * no `lookup`, so requests go through `node:http` and `node:https`, on connections of its own that no other code
 * shares. Redirects are never followed: a redirect answer is an error, whatever `init.redirect` says.
 */
export function createGuardedFetch(rules: TargetRules): typeof fetch {
  const agents = { 'http:': new HttpAgent({ keepAlive: true }), 'https:': new HttpsAgent({ keepAlive: true }) };
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    if (body) headers['content-length'] = String(body.byteLength);
    return new Promise<Response>((resolve, reject) => {
      const options = { method: request.method, headers, lookup: guardedLookup(url, rules), signal: request.signal };
      const onResponse = (res: IncomingMessage): void => {
        if (REDIRECTS.has(res.statusCode ?? 0)) {
          res.destroy();
          reject(new TypeError('fetch failed: redirect refused'));
          return;
        }
        resolve(toResponse(res, request.method));
      };
      const req = url.protocol === 'https:'
        ? httpsRequest(url, { ...options, agent: agents['https:'] }, onResponse)
        : httpRequest(url, { ...options, agent: agents['http:'] }, onResponse);
      req.on('error', reject);
      req.end(body);
    });
  };
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
export async function fetchDocument(url: URL, maxBytes: number, signal: AbortSignal | undefined, send: typeof fetch = fetch): Promise<unknown> {
  const init: RequestInit = { headers: { accept: 'application/json' }, redirect: 'error', credentials: 'omit' };
  if (signal) init.signal = signal;
  const res = await send(url, init);
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
export function createTransportFetch(maxResponseBytes: number, send: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await send(input, { ...init, redirect: 'error' });
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
