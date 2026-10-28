// Canonical JSON (DOCUMENT_MODEL §5). The exact algorithm is specified in spec/fixtures/README.md
// ("Canonical JSON") and pinned by spec/fixtures/canonical/*.json; the Rust core implements the same.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const SCALE = 1_000_000;

/** Rounds to at most 6 decimals (half away from zero) and turns -0 into 0. Throws on NaN / ±Infinity. */
export function canonicalNumber(n: number): number {
  if (!Number.isFinite(n)) throw new TypeError(`canonical JSON cannot encode ${n}`);
  if (Number.isInteger(n)) return n === 0 ? 0 : n;
  const r = (Math.sign(n) * Math.round(Math.abs(n) * SCALE)) / SCALE;
  // Math.round on the absolute value rounds .5 up, i.e. away from zero after the sign is restored.
  return r === 0 ? 0 : r;
}

/** Decimal text of a canonical number, never in exponent notation. */
export function formatCanonicalNumber(n: number): string {
  const v = canonicalNumber(n);
  const s = String(v);
  if (!/e/i.test(s)) return s;
  return expandExponent(s);
}

function expandExponent(s: string): string {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [mantissa = "", expPart = "0"] = body.toLowerCase().split("e");
  const exp = Number.parseInt(expPart, 10);
  const [intPart = "", fracPart = ""] = mantissa.split(".");
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/, "");
  if (out.includes(".")) out = out.replace(/\.?0+$/, "");
  return neg ? `-${out}` : out;
}

/** Compares strings by Unicode code point (equivalently, by UTF-8 bytes) — not by UTF-16 code units. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done) return cb.done ? 0 : -1;
    if (cb.done) return 1;
    const da = ca.value.codePointAt(0) ?? 0;
    const db = cb.value.codePointAt(0) ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
}

function encode(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      out.push(formatCanonicalNumber(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          const item: unknown = value[i];
          if (item === undefined || typeof item === "function" || typeof item === "symbol") {
            throw new TypeError(`canonical JSON cannot encode ${String(item)} at array index ${i}`);
          }
          encode(item, out);
        }
        out.push("]");
        return;
      }
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort(compareCodePoints);
      out.push("{");
      keys.forEach((k, i) => {
        if (i > 0) out.push(",");
        out.push(JSON.stringify(k), ":");
        encode(rec[k], out);
      });
      out.push("}");
      return;
    }
    default:
      throw new TypeError(`canonical JSON cannot encode a ${typeof value}`);
  }
}

/**
 * Canonical JSON text: object keys sorted by code point, no insignificant whitespace, numbers rounded to at most
 * 6 decimals (half away from zero) without `-0` or exponents, `undefined` object members omitted.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  encode(value, out);
  return out.join("");
}

/** sha256 (lowercase hex) of the UTF-8 bytes of `canonicalize(value)`. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** sha256 (lowercase hex) of the UTF-8 bytes of a string. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** True when two JSON values are equal after canonicalization. */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
