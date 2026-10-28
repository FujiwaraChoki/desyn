// Font loading for the engine: custom sources, the bundled OFL set (served next to the package), then Google
// Fonts through the CSS2 API. Browsers get `unicode-range` subsets from Google; each subset is registered as a
// face of the same family (the text engine looks across a family's faces per character), and for families sliced
// into many subsets (CJK, color emoji) only the slices covering the design's characters are fetched.

export interface FontFile {
  bytes: Uint8Array;
  /** Family to register the bytes under (the name the design uses). */
  family: string;
  /** Where the bytes came from (`bundled`, `google`, `custom`). */
  source: string;
  url: string;
}

export interface FontLoadRequest {
  family: string;
  weight: number;
  italic: boolean;
}

export interface FontSource {
  url: string;
  /** Weight or variable range covered (default: all). */
  weight?: number | [number, number];
  italic?: boolean;
}

export interface FontLoaderConfig {
  /** Bundled fonts: a directory URL or file name -> URL (`defaultFontUrls()`). */
  fonts: string | Record<string, string>;
  /** Google Fonts CSS2 endpoint; `false` disables on-demand fonts. */
  googleFonts?: string | false;
  /** Extra families: normalized or display name -> files. */
  sources?: Record<string, FontSource[]>;
  /** Network timeout per request (ms). */
  timeoutMs?: number;
  /** `fetch` implementation (tests). */
  fetch?: typeof fetch;
  /** Families that come from design font assets (never requested from Google). */
  assetFamilies?: Iterable<string>;
}

export const GOOGLE_FONTS_CSS2 = "https://fonts.googleapis.com/css2";

/** Files of the bundled OFL set (copied from crates/desyn-text/fonts by the build script). */
const BUNDLED: Record<string, { file: string; italic: boolean; family: string }[]> = {
  inter: [
    { file: "Inter-VF.ttf", italic: false, family: "Inter" },
    { file: "Inter-Italic-VF.ttf", italic: true, family: "Inter" },
  ],
  "instrument sans": [
    { file: "InstrumentSans-VF.ttf", italic: false, family: "Instrument Sans" },
    { file: "InstrumentSans-Italic-VF.ttf", italic: true, family: "Instrument Sans" },
  ],
  "instrument serif": [
    { file: "InstrumentSerif-Regular.ttf", italic: false, family: "Instrument Serif" },
    { file: "InstrumentSerif-Italic.ttf", italic: true, family: "Instrument Serif" },
  ],
  "jetbrains mono": [
    { file: "JetBrainsMono-VF.ttf", italic: false, family: "JetBrains Mono" },
    { file: "JetBrainsMono-Italic-VF.ttf", italic: true, family: "JetBrains Mono" },
  ],
  "noto sans arabic": [
    { file: "NotoSansArabic-VF.ttf", italic: false, family: "Noto Sans Arabic" },
  ],
  "noto sans hebrew": [
    { file: "NotoSansHebrew-VF.ttf", italic: false, family: "Noto Sans Hebrew" },
  ],
  "noto emoji": [{ file: "NotoEmoji-VF.ttf", italic: false, family: "Noto Emoji" }],
};

/** Emoji families the text engine asks for; the bundled monochrome set stands in when color emoji fail. */
const EMOJI_FAMILIES = new Set([
  "noto color emoji",
  "apple color emoji",
  "segoe ui emoji",
  "twemoji mozilla",
  "noto emoji",
]);

/** Families sliced into more files than this load only the slices covering the design's characters. */
const MAX_FULL_SUBSETS = 12;

export function normalizeFamily(family: string): string {
  return family
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** One `@font-face` block of a CSS2 answer. */
export interface CssFace {
  family: string;
  style: "normal" | "italic";
  weight: [number, number];
  url: string;
  /** Inclusive code point ranges; empty = everything. */
  ranges: [number, number][];
  /** Subset name from the preceding comment (`latin`, `cyrillic`, `[12]`). */
  subset: string | null;
}

/** Parses Google Fonts CSS2 answers (and any similar `@font-face` CSS). */
export function parseFontCss(css: string): CssFace[] {
  const out: CssFace[] = [];
  const re = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const body = m[2] ?? "";
    const prop = (name: string) => {
      const p = new RegExp(`${name}\\s*:\\s*([^;]+);?`, "i").exec(body);
      return p?.[1]?.trim();
    };
    const src = prop("src") ?? "";
    const urlMatch = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(src);
    if (!urlMatch?.[1]) continue;
    const family = (prop("font-family") ?? "").replace(/^['"]|['"]$/g, "");
    const style = /italic|oblique/i.test(prop("font-style") ?? "") ? "italic" : "normal";
    const weights = (prop("font-weight") ?? "400").split(/\s+/).map(Number).filter(Number.isFinite);
    const lo = weights[0] ?? 400;
    const hi = weights[1] ?? lo;
    out.push({
      family,
      style,
      weight: [lo, hi],
      url: urlMatch[1],
      ranges: parseUnicodeRange(prop("unicode-range") ?? ""),
      subset: m[1] ?? null,
    });
  }
  return out;
}

/** `U+0000-00FF, U+0131, U+4??` -> inclusive ranges. */
export function parseUnicodeRange(value: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of value.split(",")) {
    const t = part.trim().toUpperCase().replace(/^U\+/, "");
    if (!t) continue;
    if (t.includes("?")) {
      const lo = Number.parseInt(t.replace(/\?/g, "0"), 16);
      const hi = Number.parseInt(t.replace(/\?/g, "F"), 16);
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
      continue;
    }
    const [a, b] = t.split("-");
    const lo = Number.parseInt(a ?? "", 16);
    const hi = b ? Number.parseInt(b, 16) : lo;
    if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
  }
  return out;
}

function covers(face: CssFace, cp: number): boolean {
  if (face.ranges.length === 0) return true;
  return face.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function coversAny(face: CssFace, cps: Iterable<number>): boolean {
  for (const cp of cps) if (covers(face, cp)) return true;
  return false;
}

/** Weight Google accepts for static families (100..900 in steps of 100). */
export function cssWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 400;
  return Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
}

function googleFamilyParam(family: string): string {
  return encodeURIComponent(family.trim()).replace(/%20/g, "+");
}

interface SlicedFamily {
  family: string;
  faces: CssFace[];
  loaded: Set<string>;
}

export class FontLoader {
  private readonly cfg: Required<Omit<FontLoaderConfig, "assetFamilies" | "sources">> & {
    sources: Map<string, FontSource[]>;
  };
  private readonly loads = new Map<string, Promise<FontFile[]>>();
  private readonly fetched = new Map<string, Promise<Uint8Array>>();
  private readonly sliced = new Map<string, SlicedFamily>();
  private readonly codepoints = new Set<number>();
  private assetFamilies = new Set<string>();
  private cache: Promise<Cache | null> | null = null;

  constructor(config: FontLoaderConfig) {
    const sources = new Map<string, FontSource[]>();
    for (const [k, v] of Object.entries(config.sources ?? {})) sources.set(normalizeFamily(k), v);
    this.cfg = {
      fonts: config.fonts,
      googleFonts: config.googleFonts ?? GOOGLE_FONTS_CSS2,
      timeoutMs: config.timeoutMs ?? 15000,
      fetch: config.fetch ?? ((input, init) => fetch(input, init)),
      sources,
    };
    this.setAssetFamilies(config.assetFamilies ?? []);
  }

  /** Families provided by design font assets (skipped by on-demand loading). */
  setAssetFamilies(families: Iterable<string>): void {
    this.assetFamilies = new Set([...families].map(normalizeFamily));
  }

  /** Whether the family is in the bundled set. */
  isBundled(family: string): boolean {
    return normalizeFamily(family) in BUNDLED;
  }

  /**
   * Records characters the document uses. Returns slices of already loaded sliced families (CJK, emoji) that
   * cover new characters, fetched and ready to register.
   */
  async noteText(text: string): Promise<FontFile[]> {
    const fresh: number[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined && cp > 0x7f && !this.codepoints.has(cp)) {
        this.codepoints.add(cp);
        fresh.push(cp);
      }
    }
    if (fresh.length === 0 || this.sliced.size === 0) return [];
    const jobs: Promise<FontFile | null>[] = [];
    for (const fam of this.sliced.values()) {
      for (const face of fam.faces) {
        if (fam.loaded.has(face.url) || !coversAny(face, fresh)) continue;
        fam.loaded.add(face.url);
        jobs.push(
          this.bytes(face.url, true)
            .then((bytes) => ({ bytes, family: fam.family, source: "google", url: face.url }))
            .catch(() => {
              fam.loaded.delete(face.url);
              return null;
            }),
        );
      }
    }
    return (await Promise.all(jobs)).filter((f): f is FontFile => f !== null);
  }

  /** Loads a family / weight / style. Resolves to the files to register (possibly several subsets). */
  load(req: FontLoadRequest): Promise<FontFile[]> {
    const fam = normalizeFamily(req.family);
    const bundled = BUNDLED[fam];
    // Variable bundled files and custom sources cover every weight: one load per style.
    const key = bundled
      ? `${fam}|*|${req.italic}`
      : `${fam}|${cssWeight(req.weight)}|${req.italic}`;
    let p = this.loads.get(key);
    if (!p) {
      p = this.resolve(req, fam);
      this.loads.set(key, p);
      p.catch(() => this.loads.delete(key));
    }
    return p;
  }

  private async resolve(req: FontLoadRequest, fam: string): Promise<FontFile[]> {
    const custom = this.cfg.sources.get(fam);
    if (custom?.length) {
      const picked = custom.filter(
        (s) => (s.italic ?? false) === req.italic && weightMatches(s.weight, req.weight),
      );
      const list = picked.length
        ? picked
        : custom.filter((s) => (s.italic ?? false) === req.italic);
      const use = list.length ? list : custom;
      return Promise.all(
        use.map(async (s) => ({
          bytes: await this.bytes(s.url, false),
          family: req.family,
          source: "custom",
          url: s.url,
        })),
      );
    }
    if (this.assetFamilies.has(fam)) {
      throw new Error(`${req.family} comes from a design font asset`);
    }
    const isEmoji = EMOJI_FAMILIES.has(fam);
    // Color emoji first (Google), the bundled monochrome set otherwise.
    if (isEmoji && fam !== "noto emoji" && this.cfg.googleFonts !== false) {
      try {
        const files = await this.google({ ...req, family: "Noto Color Emoji" });
        if (files.length) return files;
      } catch {
        // fall through to the bundled emoji
      }
      return this.bundled("noto emoji", false);
    }
    if (BUNDLED[fam]) return this.bundled(fam, req.italic);
    if (this.cfg.googleFonts === false) throw new Error(`${req.family} is not available offline`);
    return this.google(req);
  }

  private async bundled(fam: string, italic: boolean): Promise<FontFile[]> {
    const list = BUNDLED[fam] ?? [];
    const entry = list.find((e) => e.italic === italic) ?? list[0];
    if (!entry) return [];
    const base = this.cfg.fonts;
    const url =
      typeof base === "string"
        ? new URL(entry.file, base.endsWith("/") ? base : `${base}/`).href
        : base[entry.file];
    if (!url) throw new Error(`bundled font ${entry.file} has no URL`);
    return [{ bytes: await this.bytes(url, false), family: entry.family, source: "bundled", url }];
  }

  private async google(req: FontLoadRequest): Promise<FontFile[]> {
    const endpoint = this.cfg.googleFonts;
    if (endpoint === false) return [];
    const family = googleFamilyParam(req.family);
    const w = cssWeight(req.weight);
    const attempts = [
      `${endpoint}?family=${family}:ital,wght@${req.italic ? 1 : 0},${w}&display=swap`,
      ...(req.italic ? [`${endpoint}?family=${family}:ital@1&display=swap`] : []),
      `${endpoint}?family=${family}:wght@${w}&display=swap`,
      `${endpoint}?family=${family}&display=swap`,
    ];
    let css: string | null = null;
    let lastStatus = 0;
    for (const url of attempts) {
      const res = await this.request(url);
      if (res.ok) {
        css = await res.text();
        break;
      }
      lastStatus = res.status;
      // 400: the family has no such weight / style; anything else is a real failure.
      if (res.status !== 400) break;
    }
    if (css === null) throw new Error(`Google Fonts has no ${req.family} (HTTP ${lastStatus})`);
    const faces = parseFontCss(css);
    if (faces.length === 0) throw new Error(`Google Fonts returned no files for ${req.family}`);
    let chosen: CssFace[];
    if (faces.length <= MAX_FULL_SUBSETS) {
      chosen = faces;
    } else {
      const sliced: SlicedFamily = { family: req.family, faces, loaded: new Set() };
      this.sliced.set(`${normalizeFamily(req.family)}|${w}|${req.italic}`, sliced);
      chosen = faces.filter((f) => coversAny(f, this.codepoints));
      if (chosen.length === 0) chosen = faces.filter((f) => covers(f, 0x41)).slice(0, 1);
      for (const f of chosen) sliced.loaded.add(f.url);
    }
    // The face that covers basic Latin first, so it is the family's primary match.
    chosen.sort((a, b) => Number(covers(b, 0x41)) - Number(covers(a, 0x41)));
    return Promise.all(
      chosen.map(async (f) => ({
        bytes: await this.bytes(f.url, true),
        family: req.family,
        source: "google",
        url: f.url,
      })),
    );
  }

  private async request(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      return await this.cfg.fetch(url, { signal: ctrl.signal, credentials: "omit" });
    } finally {
      clearTimeout(timer);
    }
  }

  private openCache(): Promise<Cache | null> {
    if (!this.cache) {
      this.cache =
        typeof caches === "undefined"
          ? Promise.resolve(null)
          : caches.open("desyn-fonts-v1").catch(() => null);
    }
    return this.cache;
  }

  /** Font bytes by URL (deduplicated; immutable font files are kept in the Cache API across sessions). */
  private bytes(url: string, persistent: boolean): Promise<Uint8Array> {
    let p = this.fetched.get(url);
    if (!p) {
      p = (async () => {
        const cache = persistent ? await this.openCache() : null;
        const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
        if (hit) return new Uint8Array(await hit.arrayBuffer());
        const res = await this.request(url);
        if (!res.ok) throw new Error(`font ${url}: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cache) {
          await cache
            .put(url, new Response(buf.slice(0), { headers: { "content-type": "font/woff2" } }))
            .catch(() => undefined);
        }
        return new Uint8Array(buf);
      })();
      this.fetched.set(url, p);
      p.catch(() => this.fetched.delete(url));
    }
    return p;
  }
}

function weightMatches(spec: FontSource["weight"], weight: number): boolean {
  if (spec === undefined) return true;
  if (typeof spec === "number") return Math.abs(spec - weight) < 50;
  return weight >= spec[0] && weight <= spec[1];
}

/** Families, weights and styles a design's text uses, plus every character (for subset selection). */
export interface DesignFontNeeds {
  fonts: FontLoadRequest[];
  text: string;
  assetFamilies: string[];
}

interface StyleLike {
  fontFamily?: unknown;
  fontWeight?: unknown;
  fontStyle?: unknown;
}

/** Collects the fonts a design needs (text runs, tables, charts) and the families its font assets provide. */
export function designFontNeeds(design: {
  nodes: Record<string, unknown>;
  assets?: Record<string, unknown>;
  styles?: { text?: Record<string, { style?: StyleLike }> };
}): DesignFontNeeds {
  const seen = new Map<string, FontLoadRequest>();
  const add = (s: StyleLike | undefined, base?: StyleLike) => {
    const fam = typeof s?.fontFamily === "string" ? s.fontFamily : base?.fontFamily;
    if (typeof fam !== "string" || !fam.trim()) return;
    const weight =
      typeof s?.fontWeight === "number"
        ? s.fontWeight
        : typeof base?.fontWeight === "number"
          ? base.fontWeight
          : 400;
    const style = typeof s?.fontStyle === "string" ? s.fontStyle : base?.fontStyle;
    // A CSS family list: every listed family may be needed.
    for (const f of fam.split(",")) {
      const family = f.trim().replace(/^["']|["']$/g, "");
      if (!family) continue;
      const req = { family, weight, italic: style === "italic" };
      seen.set(`${normalizeFamily(family)}|${weight}|${req.italic}`, req);
    }
  };
  let text = "";
  for (const node of Object.values(design.nodes)) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    if (n.type === "text") {
      const style = n.style as StyleLike | undefined;
      add(style);
      for (const run of (n.runs as { text?: unknown; style?: StyleLike }[] | undefined) ?? []) {
        if (run?.style) add(run.style, style);
        if (typeof run?.text === "string") text += run.text;
      }
    } else if (n.type === "table") {
      const base = n.defaultStyle as StyleLike | undefined;
      add(base);
      for (const cell of (n.cells as { text?: unknown; style?: StyleLike }[] | undefined) ?? []) {
        if (cell?.style) add(cell.style, base);
        if (typeof cell?.text === "string") text += cell.text;
      }
    } else if (n.type === "chart") {
      const o = n.options as { fontFamily?: unknown } | undefined;
      add({ fontFamily: o?.fontFamily, fontWeight: 400 });
      const data = n.data as { labels?: unknown[]; series?: { name?: unknown }[] } | undefined;
      for (const l of data?.labels ?? []) if (typeof l === "string") text += l;
      for (const s of data?.series ?? []) if (typeof s?.name === "string") text += s.name;
    }
  }
  for (const s of Object.values(design.styles?.text ?? {})) add(s?.style);
  const assetFamilies: string[] = [];
  for (const a of Object.values(design.assets ?? {})) {
    const asset = a as { kind?: unknown; family?: unknown };
    if (asset?.kind === "font" && typeof asset.family === "string")
      assetFamilies.push(asset.family);
  }
  return { fonts: [...seen.values()], text, assetFamilies };
}
