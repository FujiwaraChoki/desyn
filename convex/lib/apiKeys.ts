import { randomToken, sha256Hex } from "./crypto";

// API key format: "dsk_" + 43 base64url chars (256 bits). Only the sha256 hex digest is stored;
// the first 12 characters are kept as a display prefix.

export const API_KEY_PREFIX = "dsk_";
const DISPLAY_PREFIX_LENGTH = 12;

export function generateApiKey(): { secret: string; prefix: string } {
  const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { secret, prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH) };
}

export function looksLikeApiKey(value: string): boolean {
  return /^dsk_[A-Za-z0-9_-]{43}$/.test(value);
}

export async function hashApiKey(secret: string): Promise<string> {
  return await sha256Hex(secret);
}

/** Extract a key from `Authorization: Bearer dsk_…` or `x-api-key`. */
export function apiKeyFromHeaders(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const value = auth.slice(7).trim();
    if (looksLikeApiKey(value)) return value;
  }
  const header = headers.get("x-api-key")?.trim();
  return header && looksLikeApiKey(header) ? header : null;
}
