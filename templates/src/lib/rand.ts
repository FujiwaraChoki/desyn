// Deterministic randomness: every template is a pure function of its slug, so regenerating the library
// produces byte-identical designs (stable node ids, stable diffs, stable thumbnails).

export type Rng = () => number;

/** FNV-1a 32-bit hash of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG seeded from a string. */
export function rng(seed: string): Rng {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: Rng, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

export function between(r: Rng, min: number, max: number): number {
  return min + r() * (max - min);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 12-char [a-z0-9] ids (DOCUMENT_MODEL §1), deterministic per generator. */
export function idGenerator(seed: string): () => string {
  const r = rng(`ids:${seed}`);
  const seen = new Set<string>();
  return () => {
    for (;;) {
      let id = "";
      for (let i = 0; i < 12; i++) id += ALPHABET[Math.floor(r() * ALPHABET.length)];
      if (id !== "root" && !seen.has(id)) {
        seen.add(id);
        return id;
      }
    }
  };
}
