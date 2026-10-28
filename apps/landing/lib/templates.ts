/**
 * Generated template previews: every card on the site is drawn from one of these specs as SVG,
 * not a stock photo. When templates/manifest.json exists (written by the templates pipeline) the
 * gallery lists the real templates instead; see parseManifest.
 */

export type TemplateLayout =
  | "poster"
  | "editorial"
  | "split"
  | "story"
  | "slide"
  | "menu"
  | "invite"
  | "resume"
  | "card"
  | "thumbnail"
  | "cover"
  | "certificate";

export type Motif =
  | "sun"
  | "arch"
  | "rings"
  | "waves"
  | "grid"
  | "stripes"
  | "blob"
  | "hills"
  | "none";

export interface TemplatePalette {
  bg: string;
  bg2: string;
  ink: string;
  accent: string;
  muted: string;
}

export interface TemplateSpec {
  slug: string;
  title: string;
  category: string;
  layout: TemplateLayout;
  ratio: [number, number];
  motif: Motif;
  palette: TemplatePalette;
  copy: {
    eyebrow: string;
    headline: string;
    sub: string;
    cta?: string;
    items?: [string, string][];
  };
  italic?: boolean;
}

const P = {
  dawn: { bg: "#fbf1e4", bg2: "#f3d3ac", ink: "#2b170b", accent: "#e8781e", muted: "#7a5638" },
  ember: { bg: "#1c0f0a", bg2: "#3d1a0e", ink: "#f7e8d4", accent: "#ffb02e", muted: "#c7a98b" },
  noon: { bg: "#fff8e6", bg2: "#ffe3a0", ink: "#1f1a10", accent: "#ff6a1f", muted: "#6e5d3c" },
  dusk: { bg: "#2a120c", bg2: "#6b2412", ink: "#ffe9d0", accent: "#ff8a3d", muted: "#e0b597" },
  sand: { bg: "#efe6d8", bg2: "#e2d3bc", ink: "#26211b", accent: "#c4451c", muted: "#6f6455" },
  ink: { bg: "#111111", bg2: "#1d1d1d", ink: "#ededed", accent: "#ffb02e", muted: "#9a9a9a" },
  paper: { bg: "#ffffff", bg2: "#f6f2ea", ink: "#171717", accent: "#d27400", muted: "#77716a" },
  clay: { bg: "#d9825b", bg2: "#b8532f", ink: "#fff3e6", accent: "#ffe2a8", muted: "#ffd9bd" },
  olive: { bg: "#e9e4cf", bg2: "#d4cba6", ink: "#2c2a1a", accent: "#8a5a00", muted: "#6b6546" },
  night: { bg: "#0c0b0a", bg2: "#231a12", ink: "#f3e6d3", accent: "#c9a46a", muted: "#a8977f" },
} satisfies Record<string, TemplatePalette>;

export const TEMPLATE_SPECS: TemplateSpec[] = [
  {
    slug: "slow-mornings",
    title: "Product launch poster",
    category: "Posters",
    layout: "poster",
    ratio: [4, 5],
    motif: "sun",
    palette: P.dawn,
    copy: {
      eyebrow: "New · stoneware",
      headline: "Slow mornings.",
      sub: "Hand-thrown, glazed in first light.",
      cta: "Pre-order",
    },
  },
  {
    slug: "late-light",
    title: "Gig announcement",
    category: "Social posts",
    layout: "editorial",
    ratio: [4, 5],
    motif: "rings",
    palette: P.ember,
    copy: {
      eyebrow: "Fri · 9 pm",
      headline: "Late light jazz.",
      sub: "Three sets, one trio.",
      cta: "Tickets",
    },
  },
  {
    slug: "rise",
    title: "Retreat story",
    category: "Stories",
    layout: "story",
    ratio: [9, 16],
    motif: "hills",
    palette: P.noon,
    copy: {
      eyebrow: "12–14 June",
      headline: "Rise with the sun.",
      sub: "A weekend of yoga in the hills.",
      cta: "Book",
    },
  },
  {
    slug: "quarterly",
    title: "Quarterly review deck",
    category: "Presentations",
    layout: "slide",
    ratio: [16, 9],
    motif: "grid",
    palette: P.ink,
    copy: {
      eyebrow: "Q3 review",
      headline: "Growth, with care.",
      sub: "What worked, what did not, what is next.",
    },
  },
  {
    slug: "wine-bar",
    title: "Wine bar menu",
    category: "Menus",
    layout: "menu",
    ratio: [3, 4],
    motif: "none",
    palette: P.sand,
    copy: {
      eyebrow: "Tasca do Sol",
      headline: "Tonight",
      sub: "Natural wines · small plates",
      items: [
        ["Vinho verde", "7"],
        ["Petiscos", "9"],
        ["Bacalhau", "16"],
        ["Pastel de nata", "4"],
      ],
    },
  },
  {
    slug: "wedding",
    title: "Wedding invitation",
    category: "Invitations",
    layout: "invite",
    ratio: [5, 7],
    motif: "arch",
    palette: P.paper,
    copy: {
      eyebrow: "Together with their families",
      headline: "Ana & Leo",
      sub: "Saturday 6 June · Sintra",
      cta: "RSVP",
    },
    italic: true,
  },
  {
    slug: "resume",
    title: "Minimal résumé",
    category: "Résumés",
    layout: "resume",
    ratio: [3, 4],
    motif: "none",
    palette: P.paper,
    copy: { eyebrow: "Product designer", headline: "Mira Okafor", sub: "Lisbon · mira.design" },
  },
  {
    slug: "studio-card",
    title: "Studio business card",
    category: "Business cards",
    layout: "card",
    ratio: [7, 4],
    motif: "sun",
    palette: P.ember,
    copy: { eyebrow: "Founder", headline: "Hale Studio", sub: "hello@hale.studio" },
  },
  {
    slug: "ten-tips",
    title: "Video thumbnail",
    category: "Thumbnails",
    layout: "thumbnail",
    ratio: [16, 9],
    motif: "blob",
    palette: P.clay,
    copy: { eyebrow: "Episode 14", headline: "10 type tips", sub: "in 6 minutes" },
  },
  {
    slug: "novel",
    title: "Novel cover",
    category: "Book covers",
    layout: "cover",
    ratio: [2, 3],
    motif: "waves",
    palette: P.dusk,
    copy: { eyebrow: "A novel", headline: "The Salt Year", sub: "Inês Carvalho" },
    italic: true,
  },
  {
    slug: "certificate",
    title: "Course certificate",
    category: "Certificates",
    layout: "certificate",
    ratio: [7, 5],
    motif: "rings",
    palette: P.olive,
    copy: {
      eyebrow: "Certificate of completion",
      headline: "Jonas Weber",
      sub: "Foundations of Typography",
    },
  },
  {
    slug: "summer-sale",
    title: "Seasonal sale",
    category: "Social posts",
    layout: "split",
    ratio: [1, 1],
    motif: "stripes",
    palette: P.noon,
    copy: {
      eyebrow: "This weekend",
      headline: "Summer sale.",
      sub: "30% off everything in store.",
      cta: "Shop now",
    },
  },
  {
    slug: "open-studio",
    title: "Event flyer",
    category: "Flyers",
    layout: "poster",
    ratio: [3, 4],
    motif: "arch",
    palette: P.clay,
    copy: {
      eyebrow: "Open studio",
      headline: "Come see the kiln.",
      sub: "Sat 10–4 · Rua das Flores 12",
      cta: "Free entry",
    },
    italic: true,
  },
  {
    slug: "manifesto",
    title: "Editorial quote",
    category: "Social posts",
    layout: "editorial",
    ratio: [4, 5],
    motif: "none",
    palette: P.paper,
    copy: {
      eyebrow: "Notes on craft",
      headline: "Make fewer, better things.",
      sub: "— the workshop rule",
    },
    italic: true,
  },
  {
    slug: "pitch",
    title: "Pitch deck cover",
    category: "Presentations",
    layout: "slide",
    ratio: [16, 9],
    motif: "sun",
    palette: P.night,
    copy: {
      eyebrow: "Seed · 2026",
      headline: "Light, bottled.",
      sub: "Solar storage for small homes.",
    },
  },
  {
    slug: "podcast",
    title: "Podcast cover",
    category: "Social posts",
    layout: "cover",
    ratio: [1, 1],
    motif: "rings",
    palette: P.ember,
    copy: { eyebrow: "A podcast", headline: "Golden Hour", sub: "Conversations with makers" },
  },
  {
    slug: "run-club",
    title: "Run club story",
    category: "Stories",
    layout: "story",
    ratio: [9, 16],
    motif: "sun",
    palette: P.dusk,
    copy: {
      eyebrow: "Every Thursday",
      headline: "Chase the sunset.",
      sub: "5 km · all paces welcome",
      cta: "Join",
    },
  },
  {
    slug: "newsletter",
    title: "Newsletter header",
    category: "Banners",
    layout: "split",
    ratio: [3, 1],
    motif: "waves",
    palette: P.sand,
    copy: {
      eyebrow: "Issue 42",
      headline: "The Long Light",
      sub: "Letters on design and slowness",
    },
  },
];

export const TEMPLATE_CATEGORIES = [...new Set(TEMPLATE_SPECS.map((t) => t.category))];

/* ---------- templates/manifest.json (written by the templates pipeline) ---------- */

export interface ManifestEntry {
  slug: string;
  title: string;
  category: string;
  kind: string;
  premium: boolean;
  /** Absolute https URL or a site path (`/template-previews/...`); otherwise a generated preview is shown. */
  thumbnail: string | null;
  /** Design size in px, used for the preview's aspect ratio. */
  width?: number;
  height?: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Parses the manifest tolerantly: accepts `[...]`, `{ templates: [...] }` or `{ items: [...] }`,
 * skips malformed entries rather than failing the page.
 */
export function parseManifest(data: unknown): ManifestEntry[] {
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((((data as Record<string, unknown>).templates ??
          (data as Record<string, unknown>).items) as unknown[]) ?? [])
      : [];
  if (!Array.isArray(list)) return [];
  const out: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const slug = str(r.slug) ?? str(r.id);
    const title = str(r.title) ?? str(r.name);
    if (!slug || !title || seen.has(slug)) continue;
    seen.add(slug);
    const categories = Array.isArray(r.category)
      ? r.category
      : Array.isArray(r.categories)
        ? r.categories
        : [r.category];
    const category = str(categories[0]) ?? "Templates";
    const thumbRaw =
      str(r.thumbnail) ??
      str(r.thumb) ??
      str((r.thumbs as Record<string, unknown> | undefined)?.small);
    out.push({
      slug,
      title,
      category: category.charAt(0).toUpperCase() + category.slice(1),
      kind: str(r.kind) ?? "design",
      premium: r.premium === true,
      thumbnail: thumbRaw && /^(https:\/\/|\/template-previews\/)/.test(thumbRaw) ? thumbRaw : null,
      ...(typeof r.width === "number" && typeof r.height === "number" && r.width > 0 && r.height > 0
        ? { width: r.width, height: r.height }
        : {}),
    });
  }
  return out;
}

/** Deterministic spec for a manifest entry without a thumbnail, so its card still looks designed. */
export function specForEntry(entry: ManifestEntry): TemplateSpec {
  let h = 0;
  for (const ch of entry.slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const base = TEMPLATE_SPECS[h % TEMPLATE_SPECS.length] as TemplateSpec;
  const words = entry.title.split(/\s+/);
  return {
    ...base,
    slug: entry.slug,
    title: entry.title,
    category: entry.category,
    copy: {
      ...base.copy,
      eyebrow: entry.category,
      headline: words.slice(0, 3).join(" "),
      sub: entry.kind.replace(/-/g, " "),
    },
  };
}
