// Scaling of node geometry and size-dependent properties (used by page resize strategies).
import type { CornerRadius, Effect, Node, Stroke, TextRun, TextStyle } from "@desyn/schema";
import { scalePath } from "./svgpath";
import { type JsonObject, roundGeom } from "./util";

const r = roundGeom;

function scaleStrokes(strokes: Stroke[], k: number): Stroke[] {
  return strokes.map((s) => {
    const out: Stroke = { ...s, width: r(s.width * k) };
    if (s.dash) out.dash = s.dash.map((d) => r(d * k));
    return out;
  });
}

function scaleRadius(radius: CornerRadius, k: number): CornerRadius {
  return typeof radius === "number"
    ? r(radius * k)
    : (radius.map((v) => r(v * k)) as [number, number, number, number]);
}

function scaleEffects(effects: Effect[], k: number): Effect[] {
  return effects.map((e) => {
    switch (e.type) {
      case "dropShadow":
      case "innerShadow":
        return { ...e, x: r(e.x * k), y: r(e.y * k), blur: r(e.blur * k), spread: r(e.spread * k) };
      case "layerBlur":
      case "backgroundBlur":
      case "glow":
        return { ...e, radius: r(e.radius * k) };
      default:
        return e;
    }
  });
}

function scaleTextStyle<T extends Partial<TextStyle>>(style: T, k: number): T {
  return style.fontSize === undefined ? style : { ...style, fontSize: r(style.fontSize * k) };
}

/**
 * Path data that does not parse cannot be rendered either; it is kept verbatim instead of failing the whole
 * resize (the schema only requires `d` to be a string).
 */
function scalePathOrKeep(d: string, sx: number, sy: number): string {
  try {
    return scalePath(d, sx, sy);
  } catch {
    return d;
  }
}

/**
 * Properties of `node` after scaling its coordinate system by (sx, sy). `k` scales sizes that must stay
 * proportional (font sizes, stroke widths, radii, shadows); pass sqrt(sx * sy) or min(sx, sy). Position is
 * included when `withPosition`; the returned object only holds keys that change.
 */
export function scaledProps(
  node: Node,
  sx: number,
  sy: number,
  k: number,
  withPosition = true,
): JsonObject {
  const set: JsonObject = {
    width: r(node.width * Math.abs(sx)),
    height: r(node.height * Math.abs(sy)),
  };
  if (withPosition) {
    set.x = r(node.x * sx);
    set.y = r(node.y * sy);
  }
  if (node.effects.length > 0) set.effects = scaleEffects(node.effects, k);
  const n = node as Node & {
    strokes?: Stroke[];
    cornerRadius?: CornerRadius;
    layout?: { gap: number; rowGap?: number; padding: [number, number, number, number] };
  };
  if (n.strokes && n.strokes.length > 0) set.strokes = scaleStrokes(n.strokes, k);
  if (n.cornerRadius !== undefined) set.cornerRadius = scaleRadius(n.cornerRadius, k);
  if (n.layout) {
    const layout = { ...n.layout, gap: r(n.layout.gap * k) };
    if (n.layout.rowGap !== undefined) layout.rowGap = r(n.layout.rowGap * k);
    layout.padding = n.layout.padding.map((p) => r(p * k)) as [number, number, number, number];
    set.layout = layout;
  }
  switch (node.type) {
    case "text": {
      set.style = scaleTextStyle(node.style, k);
      if (node.runs.some((run) => run.style?.fontSize !== undefined)) {
        set.runs = node.runs.map(
          (run): TextRun => (run.style ? { ...run, style: scaleTextStyle(run.style, k) } : run),
        );
      }
      const p = node.paragraph;
      const lineHeight =
        p.lineHeight.unit === "px"
          ? { ...p.lineHeight, value: r(p.lineHeight.value * k) }
          : p.lineHeight;
      set.paragraph = { ...p, lineHeight, spacing: r(p.spacing * k), indent: r(p.indent * k) };
      break;
    }
    case "path":
      set.paths = node.paths.map((p) => ({ ...p, d: scalePathOrKeep(p.d, sx, sy) }));
      break;
    case "table":
      set.colWidths = node.colWidths.map((w) => r(w * Math.abs(sx)));
      set.rowHeights = node.rowHeights.map((h) => r(h * Math.abs(sy)));
      set.cellPadding = r(node.cellPadding * k);
      set.borderWidth = r(node.borderWidth * k);
      set.defaultStyle = scaleTextStyle(node.defaultStyle, k);
      set.cells = node.cells.map((c) =>
        c.style ? { ...c, style: scaleTextStyle(c.style, k) } : c,
      );
      break;
    case "chart":
      set.options = { ...node.options, fontSize: r(node.options.fontSize * k) };
      break;
    default:
      break;
  }
  return set;
}
