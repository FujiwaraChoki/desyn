import { cssColor, mixRgba, parseColor, toHex } from "./color.ts";

/**
 * Paint values edited by the color picker. Field names match `Fill` in docs/DOCUMENT_MODEL.md
 * (minus `opacity`/`visible`/`blend`, which belong to the fill list UI), so the editor can spread a
 * picker value straight into a fill.
 */
export interface GradientStop {
  /** 0..1 along the gradient. */
  pos: number;
  /** `#rrggbb` or `#rrggbbaa`. */
  color: string;
}
export interface SolidPaint {
  type: "solid";
  color: string;
}
export interface LinearPaint {
  type: "linear";
  /** Degrees, CSS convention (0 = to top, 90 = to right). */
  angle: number;
  stops: GradientStop[];
}
export interface RadialPaint {
  type: "radial";
  /** Center and radii, normalized 0..1 of the box. */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  stops: GradientStop[];
}
export interface ConicPaint {
  type: "conic";
  cx: number;
  cy: number;
  angle: number;
  stops: GradientStop[];
}
export type GradientPaint = LinearPaint | RadialPaint | ConicPaint;
export type Paint = SolidPaint | GradientPaint;
export type PaintType = Paint["type"];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** A finite number for CSS output (paints may come from untrusted documents). */
const num = (n: unknown, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? n : fallback;
const pct = (n: unknown, fallback: number) => `${Math.round(num(n, fallback) * 10000) / 100}%`;

/** Stops sorted by position (stable for equal positions). */
export function sortStops(stops: GradientStop[]): GradientStop[] {
  return stops
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.pos - b.s.pos || a.i - b.i)
    .map(({ s }) => s);
}

/** The interpolated color at `pos` (used when the user clicks the bar to add a stop). */
export function colorAt(stops: GradientStop[], pos: number): string {
  const sorted = sortStops(stops);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return "#000000";
  if (pos <= first.pos) return first.color;
  if (pos >= last.pos) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a || !b) continue;
    if (pos >= a.pos && pos <= b.pos) {
      const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
      const ca = parseColor(a.color);
      const cb = parseColor(b.color);
      if (!ca || !cb) return a.color;
      return toHex(mixRgba(ca, cb, t));
    }
  }
  return last.color;
}

/** CSS stop list. Colors are normalized to hex; a lone stop is doubled so the CSS stays valid. */
function cssStops(stops: GradientStop[]): string {
  const list = sortStops(stops).map(
    (s) => `${cssColor(s.color)} ${pct(clamp01(num(s.pos, 0)), 0)}`,
  );
  if (list.length === 0) return "transparent, transparent";
  return list.length === 1 ? `${list[0]}, ${list[0]}` : list.join(", ");
}

/** A horizontal preview of the stops (for the gradient bar), independent of paint geometry. */
export function stopsToCss(stops: GradientStop[]): string {
  return `linear-gradient(90deg, ${cssStops(stops)})`;
}

/**
 * CSS `background` value for any paint. Every color and number is normalized, so a paint read from
 * an untrusted document cannot inject CSS.
 */
export function paintToCss(paint: Paint): string {
  switch (paint.type) {
    case "solid":
      return cssColor(paint.color);
    case "linear":
      return `linear-gradient(${num(paint.angle, 0)}deg, ${cssStops(paint.stops)})`;
    case "radial":
      return `radial-gradient(${pct(Math.max(0, num(paint.rx, 0.5)), 0.5)} ${pct(Math.max(0, num(paint.ry, 0.5)), 0.5)} at ${pct(paint.cx, 0.5)} ${pct(paint.cy, 0.5)}, ${cssStops(paint.stops)})`;
    case "conic":
      return `conic-gradient(from ${num(paint.angle, 0)}deg at ${pct(paint.cx, 0.5)} ${pct(paint.cy, 0.5)}, ${cssStops(paint.stops)})`;
  }
}

/**
 * Converts between paint types while keeping what the user already chose: solid -> gradient uses the
 * solid color as the first stop, gradient -> solid keeps the first stop's color, and gradients keep
 * their stops, angle and center.
 */
export function convertPaint(paint: Paint, type: PaintType): Paint {
  if (paint.type === type) return paint;
  const stops: GradientStop[] =
    paint.type === "solid"
      ? [
          { pos: 0, color: paint.color },
          { pos: 1, color: transparentOf(paint.color) },
        ]
      : paint.stops;
  const angle = paint.type === "linear" || paint.type === "conic" ? paint.angle : 90;
  const center =
    paint.type === "radial" || paint.type === "conic"
      ? { cx: paint.cx, cy: paint.cy }
      : { cx: 0.5, cy: 0.5 };
  switch (type) {
    case "solid":
      return { type: "solid", color: sortStops(stops)[0]?.color ?? "#000000" };
    case "linear":
      return { type: "linear", angle, stops };
    case "radial":
      return { type: "radial", ...center, rx: 0.5, ry: 0.5, stops };
    case "conic":
      return { type: "conic", ...center, angle: angle === 90 ? 0 : angle, stops };
  }
}

function transparentOf(color: string): string {
  const c = parseColor(color);
  return c ? toHex({ ...c, a: 0 }, true) : "#00000000";
}

/** Normalizes an angle into 0..359. */
export function normalizeAngle(deg: number): number {
  return ((Math.round(deg) % 360) + 360) % 360;
}
