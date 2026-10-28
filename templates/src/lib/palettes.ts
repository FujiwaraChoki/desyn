// Curated palettes. Each one is a complete scheme (not a list of swatches): a ground, a raised surface, ink for
// text, a muted ink, and two accents, all checked for text contrast on their grounds (see test/palettes.test.ts).
// Names become the design's named color styles, so "Change the accent" edits stay one-click after instantiating.

export interface Palette {
  id: string;
  name: string;
  mood: string[];
  dark: boolean;
  /** page ground */
  bg: string;
  /** cards, panels, alternate bands */
  surface: string;
  /** primary text */
  ink: string;
  /** secondary text */
  muted: string;
  /** primary accent (buttons, highlights) */
  accent: string;
  /** secondary accent (decoration) */
  accent2: string;
  /** text drawn on top of `accent` */
  onAccent: string;
}

export const PALETTES: readonly Palette[] = [
  {
    id: "sunrise",
    name: "Sunrise",
    mood: ["warm", "bold", "modern"],
    dark: true,
    bg: "#14100b",
    surface: "#221a12",
    ink: "#f6efe4",
    muted: "#b9ab97",
    accent: "#ffb02e",
    accent2: "#ff6a1f",
    onAccent: "#1a1206",
  },
  {
    id: "linen",
    name: "Linen",
    mood: ["calm", "refined", "minimal"],
    dark: false,
    bg: "#f4efe6",
    surface: "#e9e1d3",
    ink: "#1f1b16",
    muted: "#6b6256",
    accent: "#c4451c",
    accent2: "#e8b04a",
    onAccent: "#ffffff",
  },
  {
    id: "midnight",
    name: "Midnight",
    mood: ["tech", "modern", "bold"],
    dark: true,
    bg: "#0b1020",
    surface: "#141b33",
    ink: "#eef1fb",
    muted: "#97a0c0",
    accent: "#7c9cff",
    accent2: "#38e1c6",
    onAccent: "#0b1020",
  },
  {
    id: "sage",
    name: "Sage",
    mood: ["calm", "natural", "wellness"],
    dark: false,
    bg: "#eef1ea",
    surface: "#dfe6d6",
    ink: "#1e2a1f",
    muted: "#5d6b5c",
    accent: "#3f6b4a",
    accent2: "#c8a96a",
    onAccent: "#ffffff",
  },
  {
    id: "blush",
    name: "Blush",
    mood: ["soft", "elegant", "beauty"],
    dark: false,
    bg: "#fbf1ee",
    surface: "#f4dfd8",
    ink: "#2b1a1a",
    muted: "#7d6460",
    accent: "#b84a62",
    accent2: "#e9a68f",
    onAccent: "#ffffff",
  },
  {
    id: "ink",
    name: "Ink",
    mood: ["minimal", "editorial", "classic"],
    dark: false,
    bg: "#ffffff",
    surface: "#f2f2f0",
    ink: "#111111",
    muted: "#6a6a66",
    accent: "#111111",
    accent2: "#e4572e",
    onAccent: "#ffffff",
  },
  {
    id: "noir",
    name: "Noir",
    mood: ["luxury", "bold", "editorial"],
    dark: true,
    bg: "#0c0c0c",
    surface: "#1a1a1a",
    ink: "#f5f2ea",
    muted: "#9c978c",
    accent: "#d6b36a",
    accent2: "#8c6d3a",
    onAccent: "#0c0c0c",
  },
  {
    id: "ocean",
    name: "Ocean",
    mood: ["fresh", "calm", "travel"],
    dark: false,
    bg: "#eaf4f6",
    surface: "#d3e8ec",
    ink: "#0d2a33",
    muted: "#4f6b73",
    accent: "#0f7a8a",
    accent2: "#f2a65a",
    onAccent: "#ffffff",
  },
  {
    id: "citrus",
    name: "Citrus",
    mood: ["playful", "fresh", "bold"],
    dark: false,
    bg: "#fff8e1",
    surface: "#ffeeb0",
    ink: "#1d1a10",
    muted: "#6f6748",
    accent: "#f0500f",
    accent2: "#2d9c5a",
    onAccent: "#1d1a10",
  },
  {
    id: "plum",
    name: "Plum",
    mood: ["elegant", "bold", "night"],
    dark: true,
    bg: "#1b1024",
    surface: "#2a1937",
    ink: "#f6eefb",
    muted: "#b8a3c6",
    accent: "#e07ad1",
    accent2: "#ffc46b",
    onAccent: "#1b1024",
  },
  {
    id: "forest",
    name: "Forest",
    mood: ["natural", "rustic", "calm"],
    dark: true,
    bg: "#102019",
    surface: "#1a2f25",
    ink: "#eef3ea",
    muted: "#a2b3a4",
    accent: "#d9b45a",
    accent2: "#7fb48a",
    onAccent: "#102019",
  },
  {
    id: "terracotta",
    name: "Terracotta",
    mood: ["warm", "rustic", "handmade"],
    dark: false,
    bg: "#f6ebe1",
    surface: "#ecd6c3",
    ink: "#2a1a10",
    muted: "#7a5f4d",
    accent: "#b8532c",
    accent2: "#5e7c5a",
    onAccent: "#ffffff",
  },
  {
    id: "electric",
    name: "Electric",
    mood: ["playful", "tech", "bold"],
    dark: true,
    bg: "#120a2e",
    surface: "#1f1450",
    ink: "#ffffff",
    muted: "#b5aee0",
    accent: "#c6ff3d",
    accent2: "#ff4fd8",
    onAccent: "#120a2e",
  },
  {
    id: "paper",
    name: "Paper",
    mood: ["minimal", "calm", "corporate"],
    dark: false,
    bg: "#fafaf7",
    surface: "#efefe9",
    ink: "#1b1f24",
    muted: "#646a72",
    accent: "#2457d6",
    accent2: "#f0b429",
    onAccent: "#ffffff",
  },
  {
    id: "candy",
    name: "Candy",
    mood: ["playful", "kids", "soft"],
    dark: false,
    bg: "#fff3f8",
    surface: "#ffdcec",
    ink: "#2b1430",
    muted: "#7a5a80",
    accent: "#ff3d8b",
    accent2: "#4cc9f0",
    onAccent: "#2b1430",
  },
  {
    id: "sand",
    name: "Sand",
    mood: ["calm", "travel", "luxury"],
    dark: false,
    bg: "#f3ece0",
    surface: "#e6dac5",
    ink: "#2d261c",
    muted: "#6f6352",
    accent: "#8a6a3f",
    accent2: "#2f5d62",
    onAccent: "#ffffff",
  },
  {
    id: "ember",
    name: "Ember",
    mood: ["warm", "bold", "food"],
    dark: true,
    bg: "#1c0d08",
    surface: "#2c160e",
    ink: "#fff1e6",
    muted: "#c7a594",
    accent: "#ff7a3d",
    accent2: "#ffd166",
    onAccent: "#1c0d08",
  },
  {
    id: "glacier",
    name: "Glacier",
    mood: ["fresh", "tech", "minimal"],
    dark: false,
    bg: "#f2f6fb",
    surface: "#e1e9f4",
    ink: "#0f1b2d",
    muted: "#55657d",
    accent: "#3a6df0",
    accent2: "#00b3a4",
    onAccent: "#ffffff",
  },
  {
    id: "olive",
    name: "Olive",
    mood: ["natural", "editorial", "warm"],
    dark: false,
    bg: "#f1efe4",
    surface: "#e2dfc9",
    ink: "#24261a",
    muted: "#6b6d55",
    accent: "#5f6b2b",
    accent2: "#c9772f",
    onAccent: "#ffffff",
  },
  {
    id: "rose-gold",
    name: "Rose Gold",
    mood: ["elegant", "luxury", "wedding"],
    dark: false,
    bg: "#fcf6f2",
    surface: "#f2e3da",
    ink: "#3a2a26",
    muted: "#76605a",
    accent: "#9c6550",
    accent2: "#d9b8a3",
    onAccent: "#ffffff",
  },
  {
    id: "carbon",
    name: "Carbon",
    mood: ["tech", "corporate", "minimal"],
    dark: true,
    bg: "#111315",
    surface: "#1c1f22",
    ink: "#f2f4f5",
    muted: "#9aa1a7",
    accent: "#3ddc97",
    accent2: "#5aa9ff",
    onAccent: "#0b1410",
  },
  {
    id: "marigold",
    name: "Marigold",
    mood: ["warm", "playful", "festive"],
    dark: false,
    bg: "#fff4dc",
    surface: "#ffe2a3",
    ink: "#2a1c05",
    muted: "#7a6534",
    accent: "#c8400b",
    accent2: "#7048e8",
    onAccent: "#ffffff",
  },
  {
    id: "lagoon",
    name: "Lagoon",
    mood: ["fresh", "wellness", "travel"],
    dark: true,
    bg: "#062a2e",
    surface: "#0c3c41",
    ink: "#e9fbf8",
    muted: "#9cc7c2",
    accent: "#5ce1c6",
    accent2: "#ffb38a",
    onAccent: "#062a2e",
  },
  {
    id: "berry",
    name: "Berry",
    mood: ["bold", "food", "playful"],
    dark: false,
    bg: "#fdf0f3",
    surface: "#f7d7df",
    ink: "#2c0f19",
    muted: "#7c5662",
    accent: "#a3123a",
    accent2: "#f28c28",
    onAccent: "#ffffff",
  },
];

export function palette(id: string): Palette {
  const p = PALETTES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown palette ${id}`);
  return p;
}

/** Relative luminance (WCAG 2.x). */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix two hex colors (t = 0 -> a, 1 -> b). */
export function mix(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1, 7), 16);
  const pb = Number.parseInt(b.slice(1, 7), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * t)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** `#rrggbb` + alpha 0..1 -> `#rrggbbaa`. */
export function alpha(hex: string, a: number): string {
  return `${hex.slice(0, 7)}${Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}
