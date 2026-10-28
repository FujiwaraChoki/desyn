// Small JSON-value helpers shared by the applier, diff and builders. Values are plain JSON (objects, arrays,
// strings, finite numbers, booleans, null); nothing here handles Dates, Maps or class instances.

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.hasOwn(obj, key);
}

/**
 * Defines an own enumerable property. Unlike `obj[key] = value` this never triggers the `__proto__` setter, so
 * hostile keys in ops cannot change an object's prototype.
 */
export function setOwn(obj: JsonObject, key: string, value: unknown): void {
  // Plain assignment is much faster; only "__proto__" hits an accessor on ordinary objects.
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/**
 * Shallow copy of a plain object that preserves own `__proto__` keys as data (object spread defines own
 * properties, it never invokes the `__proto__` setter).
 */
export function copyObject<T extends object>(obj: T): T {
  return { ...obj };
}

/** Deep copy of a JSON value. */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as T;
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) setOwn(out, key, deepClone((value as JsonObject)[key]));
    return out as T;
  }
  return value;
}

/** Structural equality of JSON values (object key order is irrelevant; `undefined` members are ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === "number") return Number.isNaN(a) && Number.isNaN(b as number);
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as JsonObject;
  const bo = b as JsonObject;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!hasOwn(bo, k) || !deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

export function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Rounds geometry produced by builders to 1/10000 px so transactions stay compact and stable. */
export function roundGeom(n: number): number {
  const r = Math.round(n * 10000) / 10000;
  return r === 0 ? 0 : r;
}

export class DocOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocOpsError";
  }
}
