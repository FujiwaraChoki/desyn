// Type pairings come from the shared catalog in @desyn/schema (FONT_PAIRINGS), so every template uses fonts the
// clients, the engine and the font loader already know. A template picks one by mood.
import { FONT_PAIRINGS, getFont } from "@desyn/schema";
import { pick, type Rng } from "./rand";

export interface TypePair {
  id: string;
  heading: string;
  headingWeight: number;
  body: string;
  bodyWeight: number;
  /** heading face looks right in all caps with tracking (condensed display faces) */
  caps: boolean;
  /** heading is a script / handwriting face: never set it in caps or long lines */
  script: boolean;
}

const CAPS = new Set([
  "Bebas Neue",
  "Oswald",
  "Anton",
  "Big Shoulders Display",
  "Staatliches",
  "Archivo Black",
  "Cinzel",
  "Amatic SC",
  "Unbounded",
  "Bungee",
]);
const SCRIPT = new Set([
  "Pacifico",
  "Lobster",
  "Great Vibes",
  "Dancing Script",
  "Caveat",
  "Kaushan Script",
  "Shrikhand",
]);

export const PAIRS: readonly TypePair[] = FONT_PAIRINGS.map((p) => ({
  id: p.id,
  heading: p.heading,
  headingWeight: p.headingWeight,
  body: p.body,
  bodyWeight: p.bodyWeight,
  caps: CAPS.has(p.heading),
  script: SCRIPT.has(p.heading),
}));

export function pair(heading: string, body?: string): TypePair {
  const p = PAIRS.find((x) => x.heading === heading && (body === undefined || x.body === body));
  if (!p) throw new Error(`no pairing ${heading} + ${body ?? "*"}`);
  return p;
}

/** Pairings for a set of moods (any match), falling back to the whole catalog. */
export function pairsFor(...moods: string[]): TypePair[] {
  const wanted = new Set(moods);
  const ids = new Set(
    FONT_PAIRINGS.filter((p) => p.moods.some((m) => wanted.has(m))).map((p) => p.id),
  );
  const list = PAIRS.filter((p) => ids.has(p.id));
  return list.length ? list : [...PAIRS];
}

export function pickPair(r: Rng, moods: string[], filter?: (p: TypePair) => boolean): TypePair {
  const list = pairsFor(...moods).filter(filter ?? (() => true));
  return pick(r, list.length ? list : PAIRS);
}

/** Every family a pairing needs exists in the catalog (checked in tests). */
export function pairFamiliesKnown(p: TypePair): boolean {
  return Boolean(getFont(p.heading) && getFont(p.body));
}
