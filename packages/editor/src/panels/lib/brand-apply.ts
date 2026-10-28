import { Builder, descendants } from "@desyn/doc-ops";
import {
  type Color,
  type Design,
  type Fill,
  type Id,
  type Node,
  normalizeHex,
  parseHex,
  relativeLuminance,
  rgbToHsl,
  type TextNode,
  type TextStyle,
  type Transaction,
} from "@desyn/schema";
import { resolveColor } from "./paint.ts";

/**
 * Deterministic "apply brand": restyles text with the kit's heading / body fonts (by role, else by size) and
 * maps the design's palette onto the kit's colors (chromatic colors by usage onto primary / secondary /
 * accent..., light neutrals onto the background role, dark neutrals onto the text role). Alpha is kept.
 * "Make it match my brand" with judgement is the AI's job (apply_brand tool); this is the instant version.
 */

export interface BrandSpec {
  colors: { value: string; role?: string }[];
  fonts: {
    heading?: { family: string; weight: number; style: "normal" | "italic" };
    body?: { family: string; weight: number; style: "normal" | "italic" };
  };
}

const HEADING_ROLES = new Set([
  "headline",
  "hero",
  "subhead",
  "slide-title",
  "stat",
  "price",
  "quote",
  "eyebrow",
]);
const BODY_ROLES = new Set([
  "body",
  "caption",
  "list",
  "list-item",
  "slide-body",
  "author",
  "stat-label",
  "contact",
  "date",
  "location",
  "url",
  "footer",
  "button",
  "cta",
]);

/** Text and paintable nodes under the given roots (pages or layers). */
function scopeNodes(design: Design, rootIds: Id[]): Node[] {
  const out: Node[] = [];
  const seen = new Set<Id>();
  for (const id of rootIds) {
    const root = design.nodes[id];
    if (!root) continue;
    for (const n of [root, ...descendants(design, id)]) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

function isNeutral(hex: Color): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return true;
  return rgbToHsl(rgb).s < 0.12;
}

/** Brand colors in the order chromatic document colors take them. */
function chromaticTargets(spec: BrandSpec): Color[] {
  const order = ["primary", "secondary", "accent", "other", undefined];
  const usable = spec.colors
    .map((c) => ({ value: normalizeHex(c.value), role: c.role }))
    .filter((c): c is { value: Color; role: string | undefined } => c.value !== null)
    .filter((c) => !["background", "surface", "text", "muted"].includes(c.role ?? ""));
  return [...usable]
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
    .map((c) => c.value);
}

function roleColor(spec: BrandSpec, roles: string[]): Color | null {
  for (const role of roles) {
    const hit = spec.colors.find((c) => c.role === role);
    const hex = hit ? normalizeHex(hit.value) : null;
    if (hex) return hex;
  }
  return null;
}

function fillsOf(node: Node): Fill[][] {
  const n = node as Node & {
    fills?: Fill[];
    background?: Fill[];
    strokes?: { fills: Fill[] }[];
    style?: TextStyle;
  };
  const out: Fill[][] = [];
  if (n.fills) out.push(n.fills);
  if (n.background) out.push(n.background);
  if (n.style?.fills) out.push(n.style.fills);
  for (const s of n.strokes ?? []) out.push(s.fills);
  return out;
}

/** Color usage in scope (opaque hex -> count). */
function usage(design: Design, nodes: Node[]): Map<Color, number> {
  const counts = new Map<Color, number>();
  const add = (c: Color) => counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const node of nodes) {
    for (const list of fillsOf(node)) {
      for (const f of list) {
        if (f.type === "solid") add(resolveColor(design, f.color).slice(0, 7) as Color);
        else if (f.type !== "image")
          for (const s of f.stops) add(resolveColor(design, s.color).slice(0, 7) as Color);
      }
    }
  }
  return counts;
}

/** Palette mapping (opaque hex -> brand hex) for the nodes in scope. */
export function brandColorMap(design: Design, nodes: Node[], spec: BrandSpec): Map<Color, Color> {
  const map = new Map<Color, Color>();
  const counts = usage(design, nodes);
  const targets = chromaticTargets(spec);
  const light = roleColor(spec, ["background", "surface"]);
  const dark = roleColor(spec, ["text", "muted"]);
  const chromatic = [...counts.entries()]
    .filter(([c]) => !isNeutral(c))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c);
  chromatic.forEach((c, i) => {
    const target = targets.length > 0 ? targets[i % targets.length] : undefined;
    if (target) map.set(c, target);
  });
  for (const c of counts.keys()) {
    if (!isNeutral(c)) continue;
    const lum = relativeLuminance(c);
    if (lum > 0.7 && light) map.set(c, light);
    else if (lum < 0.15 && dark) map.set(c, dark);
  }
  return map;
}

function mapColor(design: Design, value: unknown, map: Map<Color, Color>): unknown {
  const hex = resolveColor(design, value, "#00000000");
  const target = map.get(hex.slice(0, 7) as Color);
  if (!target) return value;
  // Keep the original alpha.
  return hex.length === 9 ? `${target}${hex.slice(7)}` : target;
}

function mapFills(design: Design, fills: Fill[], map: Map<Color, Color>): Fill[] {
  return fills.map((f) => {
    if (f.type === "solid") return { ...f, color: mapColor(design, f.color, map) } as Fill;
    if (f.type === "image") return f;
    return {
      ...f,
      stops: f.stops.map((s) => ({ ...s, color: mapColor(design, s.color, map) })),
    } as Fill;
  });
}

/** Heading vs body for a text node: explicit role first, then size relative to the scope. */
export function textTier(node: TextNode, headingThreshold: number): "heading" | "body" {
  if (node.role && HEADING_ROLES.has(node.role)) return "heading";
  if (node.role && BODY_ROLES.has(node.role)) return "body";
  return node.style.fontSize >= headingThreshold ? "heading" : "body";
}

/**
 * Font size at which text counts as a heading: clearly larger than the smallest text in scope (1.4x, at
 * least 24 px), and never above 32 px (a lone 72 px title is a heading even when it is the only text).
 */
export function headingThreshold(texts: TextNode[]): number {
  if (texts.length === 0) return 24;
  const smallest = Math.min(...texts.map((t) => t.style.fontSize));
  return Math.min(32, Math.max(24, smallest * 1.4));
}

function stripRunFonts(node: TextNode): TextNode["runs"] {
  return node.runs.map((run) => {
    if (!run.style) return run;
    const { fontFamily: _f, fontWeight: _w, fontStyle: _s, ...style } = run.style;
    return Object.keys(style).length > 0 ? { ...run, style } : { text: run.text };
  });
}

/** One transaction applying the brand to the given roots (pages or layers). */
export function applyBrandTransaction(
  design: Design,
  rootIds: Id[],
  spec: BrandSpec,
  options: { colors: boolean; fonts: boolean; brandKitId?: string },
): Transaction {
  const b = new Builder(design);
  const nodes = scopeNodes(design, rootIds);
  if (options.colors) {
    const map = brandColorMap(design, nodes, spec);
    if (map.size > 0) {
      for (const node of nodes) {
        const n = node as Node & {
          fills?: Fill[];
          background?: Fill[];
          strokes?: { fills: Fill[] }[];
          style?: TextStyle;
        };
        const set: Record<string, unknown> = {};
        if (n.fills) set.fills = mapFills(design, n.fills, map);
        if (n.background) set.background = mapFills(design, n.background, map);
        if (n.strokes)
          set.strokes = n.strokes.map((s) => ({ ...s, fills: mapFills(design, s.fills, map) }));
        if (node.type === "text" && n.style)
          set.style = { ...n.style, fills: mapFills(design, n.style.fills, map) };
        if (Object.keys(set).length > 0) b.update(node.id, set);
      }
    }
  }
  if (options.fonts && (spec.fonts.heading || spec.fonts.body)) {
    const texts = nodes.filter((n): n is TextNode => n.type === "text");
    const threshold = headingThreshold(texts);
    for (const t of texts) {
      const tier = textTier(t, threshold);
      const font = (tier === "heading" ? spec.fonts.heading : spec.fonts.body) ?? spec.fonts.body;
      if (!font) continue;
      const current = b.node(t.id) as TextNode;
      b.update(t.id, {
        style: {
          ...current.style,
          fontFamily: font.family,
          fontWeight: font.weight,
          fontStyle: font.style,
        },
        runs: stripRunFonts(current),
      });
    }
  }
  if (options.brandKitId && design.brandKitId !== options.brandKitId) {
    b.push({ op: "doc", set: { brandKitId: options.brandKitId } });
  }
  return b.build("Apply brand");
}
