// Bring-your-own-key storage helpers: AES-256-GCM encryption with a key derived (HKDF-SHA256) from a server secret
// (`AI_KEY_ENCRYPTION_SECRET`), plus redaction utilities so keys never reach logs, events or model context.
//
// The blob format is byte-compatible with `convex/lib/crypto.ts` (`encryptSecret` / `decryptSecret`):
// "v1.<iv>.<ciphertext+tag>" in base64url, HKDF salt "desyn/byok/v1", info "aes-256-gcm". Optional AAD binds a
// blob to its owner (e.g. `${userId}:${provider}`) so blobs cannot be swapped between users or providers.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const BYOK_FORMAT_VERSION = "v1";
const HKDF_SALT = encoder.encode("desyn/byok/v1");
const HKDF_INFO = encoder.encode("aes-256-gcm");
/** Minimum secret length accepted for key derivation. */
export const MIN_SECRET_LENGTH = 16;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (secret.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(`encryption secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  // Cache by a digest, never by the secret itself, so the map does not hold plaintext secrets as keys.
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  );
  const cacheKey = toBase64Url(digest);
  let pending = keyCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const material = await globalThis.crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return globalThis.crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(cacheKey, pending);
  }
  return pending;
}

export interface CryptoOptions {
  /** Additional authenticated data, e.g. `${userId}:${provider}`. Must match on decrypt. */
  aad?: string;
}

/** Encrypts `plaintext` (e.g. a provider API key) into a "v1.<iv>.<ct>" blob. */
export async function encryptKey(
  plaintext: string,
  secret: string,
  options: CryptoOptions = {},
): Promise<string> {
  const key = await deriveKey(secret);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const params: AesGcmParams = { name: "AES-GCM", iv: iv as BufferSource };
  if (options.aad) params.additionalData = encoder.encode(options.aad);
  const ct = await globalThis.crypto.subtle.encrypt(params, key, encoder.encode(plaintext));
  return `${BYOK_FORMAT_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** Decrypts a blob produced by `encryptKey` (or Convex `encryptSecret`). Throws on tampering or a wrong AAD. */
export async function decryptKey(
  blob: string,
  secret: string,
  options: CryptoOptions = {},
): Promise<string> {
  const [version, ivText, ctText, extra] = blob.split(".");
  if (version !== BYOK_FORMAT_VERSION || !ivText || !ctText || extra !== undefined) {
    throw new Error("unsupported encrypted key format");
  }
  const key = await deriveKey(secret);
  const params: AesGcmParams = { name: "AES-GCM", iv: fromBase64Url(ivText) as BufferSource };
  if (options.aad) params.additionalData = encoder.encode(options.aad);
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      params,
      key,
      fromBase64Url(ctText) as BufferSource,
    );
    return decoder.decode(pt);
  } catch {
    throw new Error("could not decrypt key (wrong secret, owner or corrupted blob)");
  }
}

/** True when `value` looks like an encrypted blob rather than a plaintext key. */
export function isEncryptedKey(value: string): boolean {
  return /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/.test(value);
}

/** AAD convention for BYOK blobs. */
export function byokAad(ownerId: string, provider: string): string {
  return `${ownerId}:${provider}`;
}

/** Display form of a key: last 4 characters only ("…a1b2"); short keys are fully hidden. */
export function keyHint(key: string): string {
  const trimmed = key.trim();
  return trimmed.length >= 12 ? `…${trimmed.slice(-4)}` : "…";
}

/** Fully redacted form for logs: keeps a recognisable prefix and the last 4 chars. */
export function redactKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 12) return "[redacted]";
  const prefix =
    /^(sk-or-v1-|sk-ant-|sk-proj-|sk-|gsk_|r8_|AIza|xai-|key-)/.exec(trimmed)?.[0] ?? "";
  return `${prefix}[redacted]${trimmed.slice(-4)}`;
}

// Patterns of common provider credentials. Order matters: more specific prefixes first.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-or-v1-[A-Za-z0-9]{20,}\b/g, // OpenRouter
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style
  /\bgsk_[A-Za-z0-9]{20,}\b/g, // Groq
  /\br8_[A-Za-z0-9]{20,}\b/g, // Replicate
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google
  /\bxai-[A-Za-z0-9]{20,}\b/g, // xAI
  // fal keys: "<uuid>:<32+ hex>"
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{20,}\b/gi,
  /\b(Bearer|Key|Token)\s+[A-Za-z0-9._~+/-]{16,}=*/g, // Authorization header values
];

/** Replaces anything that looks like a credential inside free text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const auth = /^(Bearer|Key|Token)\s+/.exec(match);
      return auth ? `${auth[1]} [redacted]` : redactKey(match);
    });
  }
  return out;
}

const SENSITIVE_FIELD =
  /^(api[-_]?key|apikey|api[-_]?token|token|secret|password|authorization|x-api-key|credentials?|access[-_]?key|client[-_]?secret)$/i;

/**
 * Deep copy of a JSON-like value with sensitive fields replaced and credential patterns removed from strings.
 * Safe for structured logs (Axiom) and run events.
 */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 12) return "[truncated]" as T;
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    if (value instanceof Uint8Array) return `[${value.byteLength} bytes]` as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SENSITIVE_FIELD.test(k) && v !== undefined && v !== null && v !== ""
          ? "[redacted]"
          : redactObject(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
