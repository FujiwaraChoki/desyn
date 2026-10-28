import { env } from "./env";

// WebCrypto helpers that run in both the Convex V8 runtime and Node actions.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** URL-safe random token with `bytes` bytes of entropy (default 32 = 256 bits). */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

const ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Lowercase alphanumeric random string (unbiased rejection sampling). */
export function randomAlphanumeric(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 252 && out.length < length) out += ALPHANUM[b % 36];
    }
  }
  return out;
}

export async function sha256Bytes(data: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", input as BufferSource);
  return new Uint8Array(digest);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await sha256Bytes(data));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/** Constant-time string comparison (length is not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** RFC 7636 S256: base64url(sha256(verifier)) === challenge. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = toBase64Url(await sha256Bytes(verifier));
  return timingSafeEqual(computed, challenge);
}

// ---------------------------------------------------------------------------------------------
// Secret encryption for BYOK provider keys: AES-256-GCM with a key derived (HKDF-SHA256) from
// AI_KEY_ENCRYPTION_SECRET. Format: "v1.<iv>.<ciphertext+tag>" (base64url). Optional AAD binds a
// ciphertext to its owner (e.g. `${userId}:${provider}`) so blobs cannot be swapped between users.
// ---------------------------------------------------------------------------------------------

const ENCRYPTION_VERSION = "v1";
const HKDF_SALT = encoder.encode("desyn/byok/v1");

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: encoder.encode("aes-256-gcm") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function encryptionSecret(explicit?: string): string {
  const secret = explicit ?? env.get("AI_KEY_ENCRYPTION_SECRET");
  if (!secret || secret.trim().length < 16) {
    throw new Error("AI_KEY_ENCRYPTION_SECRET is not configured (min 16 characters)");
  }
  return secret;
}

export async function encryptSecret(
  plaintext: string,
  opts: { aad?: string; secret?: string } = {},
): Promise<string> {
  const key = await deriveKey(encryptionSecret(opts.secret));
  const iv = randomBytes(12);
  const params: AesGcmParams = { name: "AES-GCM", iv: iv as BufferSource };
  if (opts.aad) params.additionalData = encoder.encode(opts.aad);
  const ct = await crypto.subtle.encrypt(params, key, encoder.encode(plaintext));
  return `${ENCRYPTION_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function decryptSecret(
  blob: string,
  opts: { aad?: string; secret?: string } = {},
): Promise<string> {
  const [version, ivText, ctText] = blob.split(".");
  if (version !== ENCRYPTION_VERSION || !ivText || !ctText) {
    throw new Error("Unsupported encrypted secret format");
  }
  const key = await deriveKey(encryptionSecret(opts.secret));
  const params: AesGcmParams = { name: "AES-GCM", iv: fromBase64Url(ivText) as BufferSource };
  if (opts.aad) params.additionalData = encoder.encode(opts.aad);
  const pt = await crypto.subtle.decrypt(params, key, fromBase64Url(ctText) as BufferSource);
  return decoder.decode(pt);
}

/** Last 4 characters for display ("…a1b2"); empty for very short secrets. */
export function secretHint(secret: string): string {
  return secret.length >= 12 ? secret.slice(-4) : "";
}
