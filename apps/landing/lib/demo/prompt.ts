import { BLUEPRINT_ORDER } from "./blueprints";
import type { Blueprint, EditId } from "./types";

const KEYWORDS: Record<Blueprint["id"], string[]> = {
  product: [
    "product",
    "launch",
    "cup",
    "coffee",
    "mug",
    "ceramic",
    "shop",
    "store",
    "sale",
    "bakery",
    "cafe",
    "café",
    "tea",
    "brand",
    "candle",
    "skincare",
    "perfume",
    "bottle",
    "wine",
    "beer",
    "menu",
    "restaurant",
    "food",
    "book",
  ],
  night: [
    "jazz",
    "music",
    "concert",
    "gig",
    "night",
    "party",
    "club",
    "dj",
    "band",
    "festival",
    "show",
    "ticket",
    "event",
    "album",
    "record",
    "vinyl",
    "bar",
    "cocktail",
    "podcast",
    "film",
    "movie",
    "premiere",
  ],
  retreat: [
    "yoga",
    "retreat",
    "wellness",
    "travel",
    "trip",
    "hike",
    "nature",
    "mountain",
    "sunrise",
    "morning",
    "meditation",
    "spa",
    "beach",
    "camp",
    "run",
    "marathon",
    "garden",
    "workshop",
    "class",
    "wedding",
    "holiday",
  ],
};

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Picks the blueprint whose vocabulary best matches the prompt (ties and misses use `fallbackIndex`). */
export function blueprintForPrompt(prompt: string, fallbackIndex = 0): Blueprint["id"] {
  const w = words(prompt);
  let best: Blueprint["id"] | null = null;
  let bestScore = 0;
  for (const id of BLUEPRINT_ORDER) {
    const score = w.filter((x) => KEYWORDS[id].includes(x)).length;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best ?? BLUEPRINT_ORDER[Math.abs(fallbackIndex) % BLUEPRINT_ORDER.length] ?? "product";
}

const LEADING = new Set([
  "make",
  "create",
  "design",
  "generate",
  "build",
  "draw",
  "give",
  "me",
  "i",
  "need",
  "want",
  "please",
  "can",
  "you",
  "a",
  "an",
  "the",
  "some",
  "new",
  "nice",
  "beautiful",
  "simple",
  "modern",
  "minimal",
  "cool",
  "quick",
  "poster",
  "post",
  "flyer",
  "banner",
  "ad",
  "story",
  "instagram",
  "social",
  "card",
  "invite",
  "invitation",
  "cover",
  "thumbnail",
  "graphic",
  "image",
  "picture",
  "logo",
  "slide",
  "for",
  "about",
  "of",
  "on",
  "to",
  "with",
  "my",
  "our",
]);

const MAX_HEADLINE = 26;

/**
 * Turns a free-form prompt into a short headline the demo can set in type, e.g.
 * "a poster for my bakery's grand opening" -> "Bakery's grand opening."
 * Returns null when nothing usable remains (the blueprint's own headline is used instead).
 */
export function headlineFromPrompt(prompt: string): string | null {
  const tokens = prompt.trim().replace(/[“”"]/g, "").split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && LEADING.has((tokens[i] ?? "").toLowerCase().replace(/[^a-z']/g, "")))
    i++;
  const rest = tokens
    .slice(i)
    .join(" ")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  if (!rest) return null;
  // Keep at most four words, and stop at a comma or dash where a clause usually begins.
  const clause = rest.split(/\s*[,–—-]\s*|\s+(?:with|and|that|which|in|at)\s+/i)[0] ?? rest;
  const short = clause.split(/\s+/).slice(0, 4).join(" ");
  if (short.length < 3 || short.length > MAX_HEADLINE) return null;
  return `${short.charAt(0).toUpperCase()}${short.slice(1)}.`;
}

const EDIT_PATTERNS: [EditId, RegExp][] = [
  ["french", /\b(french|fran[cç]ais|translate|locali[sz]e)\b/i],
  [
    "move-right",
    /\b(move|shift|push|slide)\b.*\bright\b|\bright\b.*\b(move|shift)\b|\bto the right\b/i,
  ],
  [
    "bigger-headline",
    /\b(bigger|larger|huge|enlarge|increase|louder)\b|\b(headline|title)\b.*\b(big|size)\b/i,
  ],
  ["sunset", /\b(sunset|warmer|warm|orange|palette|colou?rs?|ember|dusk)\b/i],
  [
    "premium",
    /\b(premium|luxur\w*|elegant|classy|upscale|expensive|high[- ]end|dark|moody|sophisticated|refined)\b/i,
  ],
];

/** Maps a typed instruction onto one of the edits the demo knows; null when it does not understand. */
export function editForInstruction(text: string, available: EditId[]): EditId | null {
  for (const [id, re] of EDIT_PATTERNS) {
    if (available.includes(id) && re.test(text)) return id;
  }
  return null;
}

export const EDIT_LABELS: Record<EditId, string> = {
  premium: "Make it more premium",
  "move-right": "Move the image right",
  "bigger-headline": "Make the headline bigger",
  sunset: "Try a sunset palette",
  french: "Translate to French",
};
