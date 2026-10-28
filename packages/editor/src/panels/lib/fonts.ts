import { defaultFontUrls, FontLoader } from "@desyn/engine";
import { type Design, FONT_CATALOG, getFont } from "@desyn/schema";
import type { FontOption } from "@desyn/ui";

/**
 * Fonts offered by the font pickers and their lazy previews.
 *
 * Options: the design's own font assets (uploaded / brand fonts) first, then the curated Google catalog
 * (`FONT_CATALOG`). Previews use the engine's `FontLoader` (bundled OFL set, then Google Fonts CSS2 subsets,
 * cached in the Cache API that the engine worker shares), registered as document `FontFace`s so a row can
 * render in its own face. The canvas loads the same files by itself when text starts using a family.
 */

const CATEGORY: Record<string, FontOption["category"]> = {
  "sans-serif": "sans-serif",
  serif: "serif",
  display: "display",
  handwriting: "handwriting",
  monospace: "monospace",
};

let catalogOptions: FontOption[] | null = null;

function catalog(): FontOption[] {
  catalogOptions ??= FONT_CATALOG.map((f) => ({
    family: f.family,
    category: CATEGORY[f.category] ?? "sans-serif",
    weights: f.weights,
  }));
  return catalogOptions;
}

/** Families from the design's font assets ("Uploaded"), then brand fonts, then the catalog. */
export function fontOptions(design: Design | null, brandFamilies: string[] = []): FontOption[] {
  const out: FontOption[] = [];
  const seen = new Set<string>();
  const push = (o: FontOption) => {
    const key = o.family.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(o);
  };
  for (const a of Object.values(design?.assets ?? {})) {
    if (a.kind === "font" && a.family) push({ family: a.family, source: "Uploaded" });
  }
  for (const family of brandFamilies) {
    const info = getFont(family);
    push({
      family,
      source: "Brand",
      ...(info ? { category: CATEGORY[info.category] ?? "sans-serif", weights: info.weights } : {}),
    });
  }
  for (const o of catalog()) push(o);
  return out;
}

/** Weights a family offers (catalog), else the common static set. */
export function fontWeights(family: string): number[] {
  return getFont(family)?.weights ?? [400, 700];
}

export const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

let loader: FontLoader | null = null;
const registered = new Map<string, Promise<void>>();

/**
 * Loads a family's regular face into `document.fonts` for previews (once per family). Failures resolve
 * quietly: the row keeps its fallback face.
 */
export function loadPreviewFont(family: string, weight = 400): Promise<void> {
  const key = `${family.toLowerCase()}|${weight}`;
  const existing = registered.get(key);
  if (existing) return existing;
  const p = (async () => {
    if (typeof document === "undefined" || typeof FontFace === "undefined") return;
    loader ??= new FontLoader({ fonts: defaultFontUrls() });
    // The loader puts the face covering basic Latin first; previews show the family name, so that face is
    // enough (registering every subset without its unicode-range would let a later one shadow it).
    const [file] = await loader.load({ family, weight, italic: false });
    if (!file) return;
    const face = new FontFace(family, file.bytes as unknown as ArrayBuffer, {
      weight: String(weight),
      display: "swap",
    });
    await face.load();
    document.fonts.add(face);
  })().catch(() => undefined);
  registered.set(key, p);
  return p;
}
