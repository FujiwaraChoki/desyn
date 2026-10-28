import {
  type Color,
  type ColorRef,
  type Design,
  type Fill,
  isColor,
  type Node,
  normalizeHex,
  type Stop,
} from "@desyn/schema";
import type { Paint } from "@desyn/ui";

/**
 * Conversions between document fills (DOCUMENT_MODEL `Fill`, colors may be `ColorRef`s) and the @desyn/ui
 * `Paint` values the color pickers edit (plain lowercase hex only), plus document color collection.
 */

const FALLBACK: Color = "#000000";

/** Resolves a `Color | ColorRef` against the design's variables and color styles (hex or the fallback). */
export function resolveColor(
  design: Design | null,
  color: Color | ColorRef | unknown,
  fallback: Color = FALLBACK,
): Color {
  if (typeof color === "string") return normalizeHex(color) ?? fallback;
  if (color && typeof color === "object" && design) {
    if ("$var" in color) {
      const v = design.styles.variables[String((color as { $var: unknown }).$var)];
      return typeof v === "string" ? (normalizeHex(v) ?? fallback) : fallback;
    }
    if ("$style" in color) {
      const s = design.styles.colors[String((color as { $style: unknown }).$style)];
      return s ? (normalizeHex(s.value) ?? fallback) : fallback;
    }
  }
  return fallback;
}

/** Paint for the picker; image fills have no paint (they are edited by the image fill row). */
export function fillToPaint(design: Design | null, fill: Fill): Paint | null {
  const stops = (list: Stop[]) =>
    list.map((s) => ({ pos: clamp01(s.pos), color: resolveColor(design, s.color) }));
  switch (fill.type) {
    case "solid":
      return { type: "solid", color: resolveColor(design, fill.color) };
    case "linear":
      return { type: "linear", angle: finite(fill.angle, 90), stops: stops(fill.stops) };
    case "radial":
      return {
        type: "radial",
        cx: finite(fill.cx, 0.5),
        cy: finite(fill.cy, 0.5),
        rx: finite(fill.rx, 0.5),
        ry: finite(fill.ry, 0.5),
        stops: stops(fill.stops),
      };
    case "conic":
      return {
        type: "conic",
        cx: finite(fill.cx, 0.5),
        cy: finite(fill.cy, 0.5),
        angle: finite(fill.angle, 0),
        stops: stops(fill.stops),
      };
    default:
      return null;
  }
}

/** Fill from a picker paint, keeping the previous fill's opacity / visibility / blend. */
export function paintToFill(paint: Paint, previous?: Fill): Fill {
  const extras: Partial<Pick<Fill, "opacity" | "visible" | "blend">> = {};
  if (previous?.opacity !== undefined) extras.opacity = previous.opacity;
  if (previous?.visible !== undefined) extras.visible = previous.visible;
  if (previous?.blend !== undefined) extras.blend = previous.blend;
  switch (paint.type) {
    case "solid":
      return { type: "solid", color: canonical(paint.color), ...extras };
    case "linear":
      return { type: "linear", angle: paint.angle, stops: canonStops(paint.stops), ...extras };
    case "radial":
      return {
        type: "radial",
        cx: paint.cx,
        cy: paint.cy,
        rx: paint.rx,
        ry: paint.ry,
        stops: canonStops(paint.stops),
        ...extras,
      };
    case "conic":
      return {
        type: "conic",
        cx: paint.cx,
        cy: paint.cy,
        angle: paint.angle,
        stops: canonStops(paint.stops),
        ...extras,
      };
  }
}

function canonStops(stops: { pos: number; color: string }[]): Stop[] {
  return stops.map((s) => ({
    pos: Math.round(clamp01(s.pos) * 10_000) / 10_000,
    color: canonical(s.color),
  }));
}

function canonical(color: string): Color {
  return normalizeHex(color) ?? FALLBACK;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const finite = (n: unknown, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? n : fallback;

/** CSS-safe swatch color for any fill (first stop for gradients, neutral for images). */
export function fillSwatch(design: Design | null, fill: Fill): Color {
  if (fill.type === "solid") return resolveColor(design, fill.color);
  if (fill.type === "image") return "#7a7468";
  const first = fill.stops[0];
  return first ? resolveColor(design, first.color) : FALLBACK;
}

/** Paints a node shows (fills, text fills, strokes, page backgrounds), for document color collection. */
function nodePaints(node: Node): Fill[] {
  const out: Fill[] = [];
  const n = node as Node & {
    fills?: Fill[];
    strokes?: { fills: Fill[] }[];
    background?: Fill[];
    style?: { fills?: Fill[] };
    runs?: { style?: { fills?: Fill[] } }[];
  };
  if (Array.isArray(n.fills)) out.push(...n.fills);
  if (Array.isArray(n.background)) out.push(...n.background);
  if (n.style?.fills) out.push(...n.style.fills);
  for (const run of n.runs ?? []) if (run.style?.fills) out.push(...run.style.fills);
  for (const s of n.strokes ?? []) if (Array.isArray(s.fills)) out.push(...s.fills);
  if (node.type === "qr") {
    const q = node as Node & { fg: string; bg: string };
    out.push({ type: "solid", color: q.fg }, { type: "solid", color: q.bg });
  }
  return out;
}

/**
 * Colors used in the document, most used first (opaque hex, at most `max`). Gradient stops count too.
 */
export function documentColors(design: Design | null, max = 14): Color[] {
  if (!design) return [];
  const counts = new Map<Color, number>();
  const add = (c: Color) => {
    const opaque = c.slice(0, 7) as Color;
    counts.set(opaque, (counts.get(opaque) ?? 0) + 1);
  };
  for (const node of Object.values(design.nodes)) {
    for (const fill of nodePaints(node)) {
      if (fill.type === "solid") add(resolveColor(design, fill.color));
      else if (fill.type !== "image")
        for (const s of fill.stops) add(resolveColor(design, s.color));
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([c]) => c);
}

/** True for a usable document color string. */
export function isHex(value: unknown): value is Color {
  return typeof value === "string" && isColor(value);
}
