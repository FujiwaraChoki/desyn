import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";

// Stripe webhook signature verification (https://docs.stripe.com/webhooks#verify-manually), done with
// WebCrypto so it runs in the Convex HTTP action runtime. Header format: "t=<unix>,v1=<hex>[,v1=…]".

export const DEFAULT_TOLERANCE_SEC = 300;

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | {
      ok: false;
      reason: "missing_header" | "malformed_header" | "timestamp_out_of_range" | "no_match";
    };

export function parseSignatureHeader(
  header: string,
): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) timestamp = n;
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export async function verifyStripeSignature(input: {
  payload: string;
  header: string | null;
  secret: string;
  toleranceSec?: number;
  nowSec?: number;
}): Promise<SignatureCheck> {
  if (!input.header) return { ok: false, reason: "missing_header" };
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  const expected = await hmacSha256Hex(input.secret, `${parsed.timestamp}.${input.payload}`);
  const match = parsed.signatures.some((sig) => timingSafeEqual(sig, expected));
  return match ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: "no_match" };
}

/** Build a valid signature header (used by tests and local webhook replays). */
export async function signStripePayload(
  payload: string,
  secret: string,
  timestampSec: number,
): Promise<string> {
  const sig = await hmacSha256Hex(secret, `${timestampSec}.${payload}`);
  return `t=${timestampSec},v1=${sig}`;
}
