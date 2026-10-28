// Golden prompts for the offline eval harness. Each case builds (or edits) one design with real models and is
// scored by deterministic rules (see ./score.ts). Keep prompts specific and representative of real usage; add a
// case whenever a regression is found.
import type { DesignKind } from "@desyn/schema";

export interface GoldenCase {
  id: string;
  mode: "generate" | "edit";
  kind: DesignKind;
  /** Page preset for the starting design. */
  preset?: string;
  prompt: string;
  expect: {
    /** Roles that must appear on the page (any node). */
    roles: string[];
    /** Words that must appear in the design text (case-insensitive). */
    words?: string[];
    /** Words that must NOT appear (e.g. lorem ipsum, untouched copy in edit cases). */
    forbiddenWords?: string[];
    minTextNodes?: number;
    maxFonts?: number;
  };
  /** Minimum score (0..100) to pass. */
  minScore: number;
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    id: "poster-jazz",
    mode: "generate",
    kind: "poster",
    preset: "poster-a3",
    prompt:
      "A poster for 'Midnight Jazz' at the Blue Room, Friday 24 October, doors 9 pm. Moody, warm, elegant.",
    expect: {
      roles: ["headline"],
      words: ["Midnight Jazz", "Blue Room"],
      forbiddenWords: ["lorem", "ipsum"],
      minTextNodes: 3,
      maxFonts: 3,
    },
    minScore: 70,
  },
  {
    id: "thumbnail-rust",
    mode: "generate",
    kind: "thumbnail",
    preset: "youtube-thumbnail",
    prompt:
      "YouTube thumbnail for a video titled 'I rewrote my game engine in Rust'. Bold, high contrast.",
    expect: { roles: ["headline"], words: ["Rust"], forbiddenWords: ["lorem"], maxFonts: 2 },
    minScore: 70,
  },
  {
    id: "business-card",
    mode: "generate",
    kind: "business-card",
    prompt:
      "Business card for Lena Ortiz, landscape architect at Verdant Studio, lena@verdant.studio, +49 30 1234567. Minimal and calm.",
    expect: {
      roles: [],
      words: ["Lena Ortiz", "Verdant"],
      forbiddenWords: ["lorem"],
      minTextNodes: 3,
      maxFonts: 2,
    },
    minScore: 70,
  },
  {
    id: "instagram-sale",
    mode: "generate",
    kind: "social-post",
    preset: "instagram-post",
    prompt:
      "Instagram post announcing 30% off all linen shirts this weekend for a sustainable clothing brand.",
    expect: { roles: ["headline", "cta"], words: ["30%"], forbiddenWords: ["lorem"], maxFonts: 3 },
    minScore: 70,
  },
  {
    id: "presentation-title",
    mode: "generate",
    kind: "presentation",
    prompt:
      "Title slide for a quarterly review: 'Q3 2026 — Growth and what comes next', Northwind Labs.",
    expect: { roles: [], words: ["Q3"], forbiddenWords: ["lorem"], maxFonts: 2 },
    minScore: 70,
  },
  {
    id: "edit-headline-only",
    mode: "edit",
    kind: "social-post",
    preset: "instagram-post",
    prompt:
      "Make the headline say 'Summer is here' and make it bolder. Do not change anything else.",
    expect: {
      roles: ["headline", "body"],
      words: ["Summer is here", "Fresh styles"],
      forbiddenWords: ["Spring collection"],
    },
    minScore: 80,
  },
];
