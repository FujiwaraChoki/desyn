"use node";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard for server-side AI calls. Users can point BYOK providers at their own base URLs
// (OpenAI-compatible servers, Ollama); on the hosted edition such URLs must never reach private, loopback,
// link-local or metadata addresses of our infrastructure. Every outgoing request of a run goes through
// `guardedFetch`, which resolves the host and refuses non-public addresses (also on redirects, which are
// followed manually). Self-hosters may use their LAN, so the guard is off there.

function v4ToNumber(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function inV4Block(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToNumber(ip) & mask) >>> 0 === (v4ToNumber(base) & mask) >>> 0;
}

function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4?.[1]) {
    const n = v4ToNumber(v4[1]);
    text = `${text.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined && headParts.length !== 8) return null;
  if (missing < 0) return null;
  const parts = [...headParts, ...Array(tail === undefined ? 0 : missing).fill("0"), ...tailParts];
  const words = parts.map((p) => Number.parseInt(p, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)
    ? words
    : null;
}

/** True for addresses that must not be reached from the hosted backend. */
export function isNonPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return V4_BLOCKS.some(([base, bits]) => inV4Block(ip, base, bits));
  if (family !== 6) return true;
  const w = expandV6(ip);
  if (!w) return true;
  const [a = 0, b = 0, , , , f = 0, g = 0, h = 0] = w;
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && h === 1) return true; // ::1
  const [, , c = 0, d = 0, e = 0] = w;
  const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d) and NAT64
  // (64:ff9b::/96 well-known, 64:ff9b:1::/48 local use) wrap an IPv4 address.
  const mapped = w.slice(0, 5).every((x) => x === 0) && (f === 0xffff || f === 0);
  const translated = w.slice(0, 4).every((x) => x === 0) && e === 0xffff && f === 0;
  const nat64 = a === 0x64 && b === 0xff9b && w.slice(2, 6).every((x) => x === 0);
  if (mapped || translated || nat64) return isNonPublicAddress(v4Of(g, h));
  if (a === 0x64 && b === 0xff9b && c === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  // 6to4 (2002::/16) carries the IPv4 address in the second and third words.
  if (a === 0x2002) return isNonPublicAddress(v4Of(b, c));
  // Teredo (2001::/32) tunnels to an obfuscated IPv4 address: never needed by a provider.
  if (a === 0x2001 && b === 0) return true;
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // 100::/64 discard
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  return false;
}

export class BlockedDestinationError extends Error {
  constructor(host: string) {
    super(`Requests to ${host} are not allowed from the server (private or reserved address).`);
    this.name = "BlockedDestinationError";
  }
}

const lookups = new Map<string, { at: number; ok: boolean }>();
const LOOKUP_TTL_MS = 5 * 60_000;

/** Resolves a host and throws unless every address it maps to is public. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new BlockedDestinationError(host);
  }
  if (isIP(host)) {
    if (isNonPublicAddress(host)) throw new BlockedDestinationError(host);
    return;
  }
  const cached = lookups.get(host);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) {
    if (!cached.ok) throw new BlockedDestinationError(host);
    return;
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  const ok = addresses.length > 0 && addresses.every((a) => !isNonPublicAddress(a.address));
  lookups.set(host, { at: Date.now(), ok });
  if (!ok) throw new BlockedDestinationError(host);
}

type Fetch = typeof fetch;

/** Header names that carry credentials (provider keys use several spellings). */
function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "authorization" ||
    n === "proxy-authorization" ||
    n === "cookie" ||
    /(^|-)(api-?key|key|token|secret|auth)($|-)/.test(n)
  );
}

/** A copy of the headers without credentials (for cross-origin redirects). */
export function withoutCredentials(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (!isCredentialHeader(name)) out.set(name, value);
  });
  return out;
}

/**
 * fetch that refuses non-public destinations (hosted edition). Redirects are followed manually (max 5) so
 * every hop is checked; URLs with credentials and non-http(s) schemes are refused.
 */
export function guardedFetch(options: { enabled: boolean; base?: Fetch }): Fetch {
  const base = options.base ?? fetch;
  if (!options.enabled) return base;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    let method = request.method;
    let body: ArrayBuffer | undefined =
      method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    let url = new URL(request.url);
    let headers = new Headers(request.headers);
    for (let hop = 0; hop <= 5; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new BlockedDestinationError(url.protocol);
      }
      if (url.username || url.password) throw new BlockedDestinationError(url.host);
      await assertPublicHost(url.hostname);
      const res = await base(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: request.signal,
        redirect: "manual",
      });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return res;
      const next = new URL(location, url);
      // Like fetch's own redirect handling: never forward credentials to another origin.
      if (next.origin !== url.origin) headers = withoutCredentials(headers);
      url = next;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
    }
    throw new Error("Too many redirects.");
  };
  return guarded as Fetch;
}
