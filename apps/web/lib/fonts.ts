"use client";

/*
 * On-demand loading of Google Fonts families for previews (brand kits, onboarding). The CSS is
 * fetched (connect-src) and each face is registered with the FontFace API from fonts.gstatic.com
 * (font-src), so no third-party stylesheet is injected into the page.
 */

const loaded = new Map<string, Promise<void>>();
const CSS2 = "https://fonts.googleapis.com/css2";

export function googleFontsCssUrl(family: string, weights: number[] = [400, 700]): string {
  const ws = [...new Set(weights)].filter((w) => w >= 100 && w <= 900).sort((a, b) => a - b);
  const axis = ws.length > 0 ? `:wght@${ws.join(";")}` : "";
  return `${CSS2}?family=${encodeURIComponent(family).replace(/%20/g, "+")}${axis}&display=swap`;
}

export interface ParsedFace {
  family: string;
  weight: string;
  style: string;
  url: string;
  unicodeRange?: string;
}

/** Extracts @font-face rules from a Google Fonts CSS2 response (only gstatic URLs are kept). */
export function parseFontFaces(css: string): ParsedFace[] {
  const faces: ParsedFace[] = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const family = /font-family:\s*['"]?([^;'"]+)['"]?;/.exec(block)?.[1];
    const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/.exec(block)?.[1];
    if (!family || !url) continue;
    const face: ParsedFace = {
      family,
      weight: /font-weight:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? "400",
      style: /font-style:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? "normal",
      url,
    };
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]?.trim();
    if (range) face.unicodeRange = range;
    faces.push(face);
  }
  return faces;
}

/** True when a face's unicode-range covers basic Latin (or it has no range, i.e. covers everything). */
export function coversBasicLatin(range: string | undefined): boolean {
  if (!range) return true;
  return range.split(",").some((part) => {
    const m = /U\+([0-9A-F]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
    if (!m?.[1]) return false;
    const start = Number.parseInt(m[1], 16);
    const end = m[2] ? Number.parseInt(m[2], 16) : start;
    return start <= 0x41 && end >= 0x7a;
  });
}

/**
 * Loads a family once; resolves when its Latin faces are ready, never rejects. Every subset is
 * registered, but only the Latin ones are downloaded now: the browser fetches other subsets (Greek,
 * Cyrillic, Vietnamese...) only if text needs them, instead of 5-7 files per weight up front.
 */
export function loadGoogleFont(family: string, weights?: number[]): Promise<void> {
  const key = `${family}:${(weights ?? []).join(",")}`;
  const existing = loaded.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const res = await fetch(googleFontsCssUrl(family, weights));
      if (!res.ok) return;
      const faces = parseFontFaces(await res.text());
      await Promise.all(
        faces.map(async (f) => {
          const face = new FontFace(f.family, `url(${f.url})`, {
            weight: f.weight,
            style: f.style,
            ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
            display: "swap",
          });
          document.fonts.add(face);
          if (coversBasicLatin(f.unicodeRange)) await face.load();
        }),
      );
    } catch {
      // Offline or blocked: previews fall back to the category's system font.
    }
  })();
  loaded.set(key, promise);
  return promise;
}
