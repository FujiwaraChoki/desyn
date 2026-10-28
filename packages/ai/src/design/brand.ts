// "Make this match my brand": maps a design's colors, fonts and logos onto a brand kit without moving the layout,
// then repairs text contrast. Used by the apply_brand tool and the campaign/variants workflows.

import { applyOps, descendants, getNode, pageOf, pages } from "@desyn/doc-ops";
import {
  type Color,
  contrastRatio,
  createImage,
  type Design,
  deltaE,
  ensureContrast,
  type Fill,
  type Id,
  type Node,
  nearestWeight,
  newId,
  type Op,
  type PageNode,
  relativeLuminance,
  toOklch,
} from "@desyn/schema";
import type { BrandColorRole, BrandKit } from "../host";
import { svgColors } from "../media/svg";
import { backdropColorOf } from "./describe";
import { resolveColor, textColor } from "./paint";

export interface ApplyBrandOptions {
  pageIds?: Id[];
  ids?: Id[];
  colors?: boolean;
  fonts?: boolean;
  logo?: "replace" | "add" | "none";
}

export interface BrandReport {
  ops: Op[];
  colorMap: Record<Color, Color>;
  recolored: number;
  fontsChanged: number;
  logos: Id[];
  contrastFixes: Id[];
}

const HEADING_ROLES = new Set([
  "headline",
  "subhead",
  "stat",
  "slide-title",
  "price",
  "quote",
  "eyebrow",
]);
const ACCENT_ROLES = new Set(["cta", "button", "badge", "price", "rating"]);

function brandColor(brand: BrandKit, ...roles: BrandColorRole[]): Color | undefined {
  for (const role of roles) {
    const c = brand.colors.find((x) => x.role === role)?.value;
    if (c) return c.slice(0, 7);
  }
  return undefined;
}

function lightness(c: Color): number {
  return toOklch(c.slice(0, 7)).l;
}

function chroma(c: Color): number {
  return toOklch(c.slice(0, 7)).c;
}

interface Slots {
  backgrounds: Map<Color, number>;
  surfaces: Map<Color, number>;
  accents: Map<Color, number>;
  others: Map<Color, number>;
}

function add(map: Map<Color, number>, c: Color | undefined, w: number) {
  if (!c) return;
  const hex = c.slice(0, 7);
  map.set(hex, (map.get(hex) ?? 0) + w);
}

function fillColors(fills: readonly Fill[], design: Design): Color[] {
  const out: Color[] = [];
  for (const f of fills) {
    if (f.type === "solid") {
      const c = resolveColor(f.color, design);
      if (c) out.push(c.slice(0, 7));
    } else if (f.type !== "image") {
      for (const s of f.stops) {
        const c = resolveColor(s.color, design);
        if (c) out.push(c.slice(0, 7));
      }
    }
  }
  return out;
}

/** Maps every non-text color to a brand color by usage slot, preserving light/dark structure. */
function buildColorMap(slots: Slots, brand: BrandKit): Record<Color, Color> {
  const palette = brand.colors.map((c) => c.value.slice(0, 7));
  if (palette.length === 0) return {};
  const bgLight = brandColor(brand, "background", "surface", "neutral");
  const surface = brandColor(brand, "surface", "background", "neutral");
  const primary = brandColor(brand, "primary") ?? palette[0];
  const accent = brandColor(brand, "accent", "primary", "secondary") ?? primary;
  const map: Record<Color, Color> = {};
  const nearestBy = (c: Color, candidates: Color[]) =>
    candidates.reduce((best, p) => {
      // Lightness matters more than hue so dark stays dark and light stays light.
      const d = (x: Color) => deltaE(c, x) + Math.abs(lightness(c) - lightness(x)) * 0.6;
      return d(p) < d(best) ? p : best;
    }, candidates[0] as Color);
  for (const c of slots.backgrounds.keys()) {
    const light = lightness(c) > 0.7;
    map[c] = light
      ? (bgLight ?? nearestBy(c, palette))
      : lightness(primary as Color) < 0.45
        ? (primary as Color)
        : nearestBy(c, palette);
  }
  for (const c of slots.surfaces.keys()) {
    if (map[c]) continue;
    map[c] = lightness(c) > 0.7 && surface ? surface : nearestBy(c, palette);
  }
  for (const c of slots.accents.keys()) {
    if (map[c]) continue;
    map[c] = accent as Color;
  }
  for (const c of slots.others.keys()) {
    if (map[c]) continue;
    map[c] =
      chroma(c) > 0.08
        ? nearestBy(
            c,
            palette.filter((p) => chroma(p) > 0.04).length
              ? palette.filter((p) => chroma(p) > 0.04)
              : palette,
          )
        : nearestBy(c, palette);
  }
  return map;
}

function mapFills(fills: Fill[], map: Record<Color, Color>, design: Design): Fill[] {
  return fills.map((f) => {
    if (f.type === "solid") {
      const c = resolveColor(f.color, design)?.slice(0, 7);
      return c && map[c] ? { ...f, color: map[c] } : f;
    }
    if (f.type === "image") return f;
    return {
      ...f,
      stops: f.stops.map((s) => {
        const c = resolveColor(s.color, design)?.slice(0, 7);
        return c && map[c] ? { ...s, color: map[c] } : s;
      }),
    };
  });
}

function pickLogo(brand: BrandKit, backdrop: Color | undefined) {
  if (brand.logos.length === 0) return undefined;
  const dark = backdrop ? relativeLuminance(backdrop) < 0.35 : false;
  const want = dark ? ["light", "mono", "primary"] : ["dark", "primary", "mono"];
  for (const v of want) {
    const l = brand.logos.find((x) => x.variant === v);
    if (l) return l;
  }
  return brand.logos[0];
}

export function brandOps(
  design: Design,
  brand: BrandKit,
  options: ApplyBrandOptions = {},
): BrandReport {
  const report: BrandReport = {
    ops: [],
    colorMap: {},
    recolored: 0,
    fontsChanged: 0,
    logos: [],
    contrastFixes: [],
  };
  const scopePages: PageNode[] = options.pageIds
    ? pages(design).filter((p) => options.pageIds?.includes(p.id))
    : pages(design);
  const scopeIds = options.ids
    ? new Set(options.ids.flatMap((id) => [id, ...descendants(design, id).map((d) => d.id)]))
    : undefined;
  const nodes: Node[] = scopePages
    .flatMap((p) => descendants(design, p.id))
    .filter((n) => !scopeIds || scopeIds.has(n.id));

  // 1. Classify color usage.
  const slots: Slots = {
    backgrounds: new Map(),
    surfaces: new Map(),
    accents: new Map(),
    others: new Map(),
  };
  if (!scopeIds)
    for (const p of scopePages)
      for (const c of fillColors(p.background, design))
        add(slots.backgrounds, c, p.width * p.height);
  for (const n of nodes) {
    if (n.type === "text" || n.locked) continue;
    const page = pageOf(design, n.id);
    const pageArea = page ? page.width * page.height : 1;
    const area = n.width * Math.max(n.height, 1);
    const colors =
      "fills" in n
        ? fillColors(n.fills, design)
        : n.type === "line"
          ? fillColors(n.strokes[0]?.fills ?? [], design)
          : [];
    for (const c of colors) {
      if (n.role === "background" || area >= pageArea * 0.4) add(slots.backgrounds, c, area);
      else if (ACCENT_ROLES.has(n.role ?? "") || (area < pageArea * 0.05 && chroma(c) > 0.1))
        add(slots.accents, c, area);
      else if (
        n.role === "card" ||
        n.role === "section" ||
        n.role === "header" ||
        n.role === "footer" ||
        n.type === "frame"
      )
        add(slots.surfaces, c, area);
      else add(slots.others, c, area);
    }
    if (n.type === "svg" && n.markup)
      for (const c of svgColors(n.markup)) add(slots.others, c, area);
  }

  // 2. Recolor.
  if (options.colors !== false && brand.colors.length > 0) {
    const map = buildColorMap(slots, brand);
    report.colorMap = map;
    if (!scopeIds) {
      for (const p of scopePages) {
        const next = mapFills(p.background, map, design);
        if (JSON.stringify(next) !== JSON.stringify(p.background))
          report.ops.push({ op: "update", id: p.id, set: { background: next } });
      }
    }
    for (const n of nodes) {
      if (n.locked) continue;
      if ("fills" in n) {
        const next = mapFills(n.fills, map, design);
        if (JSON.stringify(next) !== JSON.stringify(n.fills)) {
          report.ops.push({ op: "update", id: n.id, set: { fills: next } });
          report.recolored++;
        }
      } else if (n.type === "line" && n.strokes.length > 0) {
        const strokes = n.strokes.map((s) => ({ ...s, fills: mapFills(s.fills, map, design) }));
        if (JSON.stringify(strokes) !== JSON.stringify(n.strokes)) {
          report.ops.push({ op: "update", id: n.id, set: { strokes } });
          report.recolored++;
        }
      } else if (
        n.type === "svg" &&
        n.markup &&
        n.role !== "logo" &&
        n.role !== "brand-mark" &&
        n.role !== "photo"
      ) {
        const recolor: Record<Color, Color> = { ...(n.recolor ?? {}) };
        for (const c of svgColors(n.markup)) if (map[c]) recolor[c] = map[c];
        if (JSON.stringify(recolor) !== JSON.stringify(n.recolor ?? {})) {
          report.ops.push({ op: "update", id: n.id, set: { recolor } });
          report.recolored++;
        }
      } else if (n.type === "chart") {
        const palette = brand.colors.map((c) => c.value.slice(0, 7));
        report.ops.push({ op: "update", id: n.id, set: { options: { ...n.options, palette } } });
        report.recolored++;
      }
    }
  }

  // 3. Fonts.
  const heading = brand.fonts.find((f) => f.role === "heading")?.family ?? brand.fonts[0]?.family;
  const body =
    brand.fonts.find((f) => f.role === "body")?.family ?? brand.fonts[1]?.family ?? heading;
  if (options.fonts !== false && heading && body) {
    const sizes = nodes
      .filter((n) => n.type === "text")
      .map((n) => (n.type === "text" ? n.style.fontSize : 0));
    const sorted = [...sizes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 16;
    for (const n of nodes) {
      if (n.type !== "text" || n.locked) continue;
      const isHeading = HEADING_ROLES.has(n.role ?? "") || n.style.fontSize >= median * 1.6;
      const family = isHeading ? heading : body;
      const brandWeight = brand.fonts.find((f) => f.family === family)?.weight;
      const weight = nearestWeight(
        family,
        brandWeight && !isHeading ? brandWeight : n.style.fontWeight,
      );
      if (n.style.fontFamily === family && n.style.fontWeight === weight) continue;
      const runs = n.runs.map((r) => {
        if (!r.style?.fontFamily) return r;
        const { fontFamily: _f, ...rest } = r.style;
        return Object.keys(rest).length ? { text: r.text, style: rest } : { text: r.text };
      });
      report.ops.push({
        op: "update",
        id: n.id,
        set: { style: { ...n.style, fontFamily: family, fontWeight: weight }, runs },
      });
      report.fontsChanged++;
    }
  }

  // 4. Logos.
  if (options.logo !== "none" && brand.logos.length > 0) {
    const existing = nodes.filter(
      (n) =>
        (n.role === "logo" || n.role === "brand-mark") && (n.type === "image" || n.type === "svg"),
    );
    for (const n of existing) {
      const logo = pickLogo(brand, backdropColorOf(design, n.id));
      if (!logo) continue;
      const assetId = logo.assetId;
      if (n.type === "image" && n.assetId !== assetId) {
        const ratio =
          logo.width && logo.height ? logo.width / logo.height : n.width / Math.max(n.height, 1);
        const height = Math.round((n.width / ratio) * 100) / 100;
        report.ops.push({
          op: "update",
          id: n.id,
          set: {
            assetId,
            fit: "fit",
            height,
            y: Math.round((n.y + (n.height - height) / 2) * 100) / 100,
          },
          unset: ["crop"],
        });
        report.logos.push(n.id);
      } else if (n.type === "svg" && n.assetId !== assetId) {
        report.ops.push({ op: "update", id: n.id, set: { assetId }, unset: ["markup", "recolor"] });
        report.logos.push(n.id);
      }
    }
    if (existing.length === 0 && options.logo === "add") {
      for (const p of scopePages) {
        const logo = pickLogo(
          brand,
          resolveColor((p.background[0] as { color?: string } | undefined)?.color, design),
        );
        if (!logo || !design.assets[logo.assetId]) continue;
        const width = Math.round(Math.min(p.width, p.height) * 0.14);
        const ratio = logo.width && logo.height ? logo.width / logo.height : 3;
        const margin = Math.round(Math.min(p.width, p.height) * 0.06);
        const node = createImage({
          id: newId(),
          name: "Logo",
          role: "logo",
          assetId: logo.assetId,
          parent: p.id,
          x: margin,
          y: margin,
          width,
          height: Math.round(width / ratio),
          fit: "fit",
        });
        report.ops.push({ op: "create", nodes: [node], parent: p.id });
        report.logos.push(node.id);
      }
    }
  }

  // 5. Contrast repair on the recolored design.
  const preview = applyOps(design, report.ops).design;
  const brandText = brandColor(brand, "text");
  for (const n of nodes) {
    if (n.type !== "text" || n.locked) continue;
    const current = getNode(preview, n.id);
    if (current?.type !== "text") continue;
    const bg = backdropColorOf(preview, n.id);
    const fg = textColor(current, preview)?.slice(0, 7);
    if (!bg || !fg) continue;
    const large =
      current.style.fontSize >= 24 ||
      (current.style.fontWeight >= 700 && current.style.fontSize >= 18.66);
    const target = large ? 3 : 4.5;
    let next = fg;
    if (brandText && contrastRatio(brandText, bg) >= target && contrastRatio(fg, bg) < target)
      next = brandText;
    if (contrastRatio(next, bg) < target) next = ensureContrast(next, bg, target + 0.2);
    if (next !== fg) {
      const runs = current.runs.map((r) => {
        if (!r.style?.fills) return r;
        const { fills: _f, ...rest } = r.style;
        return Object.keys(rest).length ? { text: r.text, style: rest } : { text: r.text };
      });
      report.ops.push({
        op: "update",
        id: n.id,
        set: { style: { ...current.style, fills: [{ type: "solid", color: next }] }, runs },
      });
      report.contrastFixes.push(n.id);
    }
  }
  if (brand.id && design.brandKitId !== brand.id)
    report.ops.push({ op: "doc", set: { brandKitId: brand.id } });
  return report;
}
