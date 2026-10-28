import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { env } from "./env";

// Minimal S3 client: AWS Signature V4 for presigned URLs (usable in queries and mutations: synchronous and
// deterministic for a given signing date) and header-signed requests from actions. Works with AWS S3, MinIO
// (`S3_ENDPOINT` + `S3_FORCE_PATH_STYLE=true`) and Cloudflare R2 (`S3_ENDPOINT`, `AWS_REGION=auto`).
// Credentials are read by name from the environment and never logged.

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Custom endpoint origin (MinIO / R2), e.g. "http://localhost:9000". */
  endpoint?: string;
  forcePathStyle: boolean;
  /** Public base URL for objects (CDN / public bucket); when set, GET URLs are not signed. */
  publicBaseUrl?: string;
}

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const ALGORITHM = "AWS4-HMAC-SHA256";

/** S3 configuration from the environment, or null when uploads are not configured. */
export function s3Config(): S3Config | null {
  const bucket = env.get("S3_BUCKET");
  const accessKeyId = env.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = env.get("AWS_SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const forcePath = env.get("S3_FORCE_PATH_STYLE");
  const sessionToken = env.get("AWS_SESSION_TOKEN");
  const endpoint = env.get("S3_ENDPOINT");
  const publicBaseUrl = env.get("S3_PUBLIC_BASE_URL");
  return {
    bucket,
    region: env.get("AWS_REGION") ?? "us-east-1",
    accessKeyId,
    secretAccessKey,
    forcePathStyle: forcePath === "true" || forcePath === "1",
    ...(sessionToken ? { sessionToken } : {}),
    ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}),
    ...(publicBaseUrl ? { publicBaseUrl: publicBaseUrl.replace(/\/+$/, "") } : {}),
  };
}

/** RFC 3986 percent-encoding as required by SigV4. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key for the URI path (slashes kept). */
export function encodeKey(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

export interface ObjectLocation {
  protocol: "https:" | "http:";
  /** Host header value (includes a non-default port). */
  host: string;
  /** Encoded path starting with "/". */
  path: string;
}

export function objectLocation(cfg: S3Config, key: string): ObjectLocation {
  const encodedKey = encodeKey(key);
  // Bucket names with dots break virtual-hosted TLS certificates; use path style for them.
  const pathStyle = cfg.forcePathStyle || cfg.bucket.includes(".");
  if (cfg.endpoint) {
    const url = new URL(cfg.endpoint);
    const base = url.pathname.replace(/\/+$/, "");
    const protocol = url.protocol === "http:" ? "http:" : "https:";
    if (pathStyle) {
      return {
        protocol,
        host: url.host,
        path: `${base}/${encodeRfc3986(cfg.bucket)}/${encodedKey}`,
      };
    }
    return { protocol, host: `${cfg.bucket}.${url.host}`, path: `${base}/${encodedKey}` };
  }
  const regional = `s3.${cfg.region}.amazonaws.com`;
  if (pathStyle) {
    return {
      protocol: "https:",
      host: regional,
      path: `/${encodeRfc3986(cfg.bucket)}/${encodedKey}`,
    };
  }
  return { protocol: "https:", host: `${cfg.bucket}.${regional}`, path: `/${encodedKey}` };
}

function amzDates(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function hex(data: Uint8Array): string {
  return bytesToHex(data);
}

export function sha256HexSync(data: string | Uint8Array): string {
  return hex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

function signingKey(secret: string, dateStamp: string, region: string): Uint8Array {
  const kDate = hmac(sha256, utf8ToBytes(`AWS4${secret}`), utf8ToBytes(dateStamp));
  const kRegion = hmac(sha256, kDate, utf8ToBytes(region));
  const kService = hmac(sha256, kRegion, utf8ToBytes("s3"));
  return hmac(sha256, kService, utf8ToBytes("aws4_request"));
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .map((k) => [encodeRfc3986(k), encodeRfc3986(query[k] as string)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, value]) => `${k}=${value}`)
    .join("&");
}

function canonicalHeaders(headers: Record<string, string>): { block: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, value]) => [k.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    block: entries.map(([k, value]) => `${k}:${value}\n`).join(""),
    signed: entries.map(([k]) => k).join(";"),
  };
}

interface SignInput {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  date: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function signature(input: SignInput): {
  signature: string;
  signedHeaders: string;
  credential: string;
} {
  const { amzDate, dateStamp } = amzDates(input.date);
  const { block, signed: signedHeaders } = canonicalHeaders({ ...input.headers, host: input.host });
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery(input.query),
    block,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256HexSync(canonicalRequest)].join("\n");
  const key = signingKey(input.secretAccessKey, dateStamp, input.region);
  return {
    signature: hex(hmac(sha256, key, utf8ToBytes(stringToSign))),
    signedHeaders,
    credential: `${input.accessKeyId}/${scope}`,
  };
}

export interface PresignInput {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  /** Seconds the URL stays valid (1 .. 604800). */
  expiresIn: number;
  /** Signing time; defaults to now. Pass a window start for stable (cacheable) URLs. */
  date?: Date;
  /** Headers the client must send with exactly these values (e.g. content-type, content-length). */
  signedHeaders?: Record<string, string>;
  /** Extra query parameters, e.g. response-content-disposition. */
  query?: Record<string, string>;
}

/** Low-level presign for an explicit host/path (used directly by the SigV4 test vectors). */
export function presignLocation(
  cfg: Pick<S3Config, "region" | "accessKeyId" | "secretAccessKey" | "sessionToken">,
  location: ObjectLocation,
  input: PresignInput,
): string {
  const date = input.date ?? new Date();
  const { amzDate, dateStamp } = amzDates(date);
  const expires = Math.max(1, Math.min(604_800, Math.floor(input.expiresIn)));
  const headers = input.signedHeaders ?? {};
  const { signed } = canonicalHeaders({ ...headers, host: location.host });
  const query: Record<string, string> = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${cfg.accessKeyId}/${dateStamp}/${cfg.region}/s3/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signed,
  };
  if (cfg.sessionToken) query["X-Amz-Security-Token"] = cfg.sessionToken;
  const sig = signature({
    method: input.method,
    host: location.host,
    path: location.path,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
    date,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  return `${location.protocol}//${location.host}${location.path}?${canonicalQuery(query)}&X-Amz-Signature=${sig.signature}`;
}

export function presignUrl(cfg: S3Config, key: string, input: PresignInput): string {
  return presignLocation(cfg, objectLocation(cfg, key), input);
}

/** Start of the signing window containing `nowMs` (URLs signed at the window start are identical all window). */
export function windowStart(nowMs: number, windowSeconds: number): Date {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

/** Public URL for a key when S3_PUBLIC_BASE_URL is configured. */
export function publicObjectUrl(cfg: S3Config, key: string): string | null {
  return cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/${encodeKey(key)}` : null;
}

export interface SignedHeadersInput {
  method: string;
  location: ObjectLocation;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  payloadHash?: string;
  date?: Date;
}

/** Headers (incl. Authorization) for a header-signed request. */
export function signedRequestHeaders(
  cfg: Pick<S3Config, "region" | "accessKeyId" | "secretAccessKey" | "sessionToken">,
  input: SignedHeadersInput,
): Record<string, string> {
  const date = input.date ?? new Date();
  const { amzDate } = amzDates(date);
  const payloadHash = input.payloadHash ?? UNSIGNED_PAYLOAD;
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (cfg.sessionToken) headers["x-amz-security-token"] = cfg.sessionToken;
  const sig = signature({
    method: input.method,
    host: input.location.host,
    path: input.location.path,
    query: input.query ?? {},
    headers,
    payloadHash,
    date,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${sig.credential}, SignedHeaders=${sig.signedHeaders}, Signature=${sig.signature}`,
  };
}

export interface S3RequestInput {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  key: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  query?: Record<string, string>;
}

/** Perform a signed request against the object (actions only: uses fetch). */
export async function s3Request(cfg: S3Config, input: S3RequestInput): Promise<Response> {
  const location = objectLocation(cfg, input.key);
  const headers = signedRequestHeaders(cfg, {
    method: input.method,
    location,
    headers: input.headers ?? {},
    query: input.query ?? {},
    payloadHash: input.body ? sha256HexSync(input.body) : UNSIGNED_PAYLOAD,
  });
  const qs =
    input.query && Object.keys(input.query).length > 0 ? `?${canonicalQuery(input.query)}` : "";
  return await fetch(`${location.protocol}//${location.host}${location.path}${qs}`, {
    method: input.method,
    headers,
    ...(input.body ? { body: input.body as BodyInit } : {}),
  });
}

/** Content-Disposition value for downloads (RFC 6266 with an ASCII fallback). */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc3986(fileName)}`;
}
