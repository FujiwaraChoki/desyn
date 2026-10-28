import { ID_PATTERN, ROOT_ID } from "./constants";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const ID_LENGTH = 12;
// Largest multiple of 36 that fits in a byte: bytes >= 252 are rejected so every symbol is equally likely.
const REJECT_FROM = 252;

/** A fresh 12-char [a-z0-9] id from the platform CSPRNG (Web Crypto; available in browsers, Node and Convex). */
export function newId(): string {
  let out = "";
  const buf = new Uint8Array(24);
  while (out.length < ID_LENGTH) {
    globalThis.crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= REJECT_FROM) continue;
      out += ALPHABET[byte % 36];
      if (out.length === ID_LENGTH) break;
    }
  }
  return out;
}

/** True for a well-formed generated id (12 chars [a-z0-9]). The reserved "root" is not an Id. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** True for any id that may name a node: a generated id or "root". */
export function isNodeId(value: unknown): value is string {
  return value === ROOT_ID || isId(value);
}
