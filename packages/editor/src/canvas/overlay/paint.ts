import type { ViewState } from "@desyn/engine";
import { apply, type Matrix, type Obb, obbCorners, type Point } from "../math.ts";

/**
 * Canvas 2D painting helpers for the interaction overlay. Everything is drawn in screen space (CSS px, the
 * context is pre-scaled by the device pixel ratio) from page-space geometry, so strokes stay hairline-crisp at
 * every zoom. Colors come from the design tokens (DESIGN_SYSTEM §3: sun selection, white 8 px handles with a sun
 * border and a dark hairline outline).
 */

export interface OverlayTheme {
  /** Selection outline / handle border (sun). */
  selection: string;
  /** Text on sun-filled labels. */
  ink: string;
  /** Measurements, spacing and distance guides (ember). */
  measure: string;
  /** Layout grid columns. */
  grid: string;
  /** Ruler guides. */
  guide: string;
  foreground: string;
  surface: string;
  canvas: string;
  danger: string;
  fontSans: string;
  fontMono: string;
  dark: boolean;
}

const FALLBACK: OverlayTheme = {
  selection: "#ffb02e",
  ink: "#1a1205",
  measure: "#ff6a1f",
  grid: "rgba(255, 106, 31, 0.08)",
  guide: "#ff6a1f",
  foreground: "#ededed",
  surface: "#111111",
  canvas: "#0e0e0e",
  danger: "#ff5c5c",
  fontSans: "'Instrument Sans Variable', 'Instrument Sans', ui-sans-serif, system-ui, sans-serif",
  fontMono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
  dark: true,
};

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m?.[1]) return 0;
  const n = Number.parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Reads overlay colors from the design tokens on `el` (falls back to the dark sun palette). */
export function readTheme(el: Element): OverlayTheme {
  if (typeof getComputedStyle !== "function") return FALLBACK;
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const canvas = v("--canvas", FALLBACK.canvas);
  const dark = luminance(canvas) < 0.5;
  const lo = v("--accent-lo", "#ff6a1f");
  return {
    selection: v("--selection", FALLBACK.selection),
    ink: v("--accent-ink", FALLBACK.ink),
    measure: dark ? lo : "#e0480f",
    grid: dark ? "rgba(255, 106, 31, 0.09)" : "rgba(224, 72, 15, 0.08)",
    guide: dark ? lo : "#e0480f",
    foreground: v("--foreground", FALLBACK.foreground),
    surface: v("--surface-1", FALLBACK.surface),
    canvas,
    danger: v("--danger", FALLBACK.danger),
    fontSans: v("--font-family-sans", FALLBACK.fontSans),
    fontMono: v("--font-family-mono", FALLBACK.fontMono),
    dark,
  };
}

export const HANDLE_SIZE = 8;

export class Painter {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly view: ViewState,
    readonly theme: OverlayTheme,
  ) {}

  /** Page -> screen (CSS px). */
  s(p: Point): Point {
    return { x: (p.x - this.view.x) * this.view.zoom, y: (p.y - this.view.y) * this.view.zoom };
  }

  get zoom(): number {
    return this.view.zoom;
  }

  /** Rounds a screen coordinate to the device pixel grid (+ half a pixel for odd-width strokes). */
  crisp(v: number, width = 1): number {
    const dpr = this.view.dpr || 1;
    const px = Math.round(v * dpr) / dpr;
    return Math.round(width * dpr) % 2 === 1 ? px + 0.5 / dpr : px;
  }

  polygon(points: readonly Point[], close = true): void {
    const c = this.ctx;
    c.beginPath();
    points.forEach((p, i) => {
      const q = this.s(p);
      if (i === 0) c.moveTo(q.x, q.y);
      else c.lineTo(q.x, q.y);
    });
    if (close) c.closePath();
  }

  strokeObb(o: Obb, color: string, width = 1, dash?: number[]): void {
    this.polygon(obbCorners(o));
    this.stroke(color, width, dash);
  }

  stroke(color: string, width = 1, dash?: number[]): void {
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash ?? []);
    c.stroke();
    c.setLineDash([]);
  }

  /** Strokes a path given in a node's local box, transformed by `m` (page) then the view. */
  strokeLocalPath(path: Path2D, m: Matrix, color: string, width = 1, dash?: number[]): void {
    const c = this.ctx;
    const z = this.view.zoom;
    // Strokes must not scale with the transform: transform the path, keep the stroke in screen space.
    const t = new DOMMatrix([
      m[0] * z,
      m[1] * z,
      m[2] * z,
      m[3] * z,
      (m[4] - this.view.x) * z,
      (m[5] - this.view.y) * z,
    ]);
    const transformed = new Path2D();
    transformed.addPath(path, t);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash ?? []);
    c.stroke(transformed);
    c.setLineDash([]);
  }

  line(a: Point, b: Point, color: string, width = 1, dash?: number[]): void {
    const p = this.s(a);
    const q = this.s(b);
    const c = this.ctx;
    c.beginPath();
    // Axis-aligned lines are snapped to the pixel grid so they stay one device pixel sharp.
    if (Math.abs(p.x - q.x) < 0.01) {
      const x = this.crisp(p.x, width);
      c.moveTo(x, p.y);
      c.lineTo(x, q.y);
    } else if (Math.abs(p.y - q.y) < 0.01) {
      const y = this.crisp(p.y, width);
      c.moveTo(p.x, y);
      c.lineTo(q.x, y);
    } else {
      c.moveTo(p.x, p.y);
      c.lineTo(q.x, q.y);
    }
    this.stroke(color, width, dash);
  }

  /** Screen-space line (rulers, labels). */
  screenLine(a: Point, b: Point, color: string, width = 1, dash?: number[]): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    this.stroke(color, width, dash);
  }

  /** A square resize handle at a page point, rotated by `deg`. */
  squareHandle(at: Point, deg = 0, size = HANDLE_SIZE, active = false): void {
    const p = this.s(at);
    const c = this.ctx;
    c.save();
    c.translate(p.x, p.y);
    if (deg) c.rotate((deg * Math.PI) / 180);
    const h = size / 2;
    c.beginPath();
    c.roundRect(-h, -h, size, size, 1.5);
    c.fillStyle = active ? this.theme.selection : "#ffffff";
    c.shadowColor = "rgba(0, 0, 0, 0.35)";
    c.shadowBlur = 3;
    c.fill();
    c.shadowColor = "transparent";
    c.lineWidth = 1.25;
    c.strokeStyle = this.theme.selection;
    c.stroke();
    c.lineWidth = 1;
    c.strokeStyle = "rgba(0, 0, 0, 0.45)";
    c.beginPath();
    c.roundRect(-h - 0.75, -h - 0.75, size + 1.5, size + 1.5, 2);
    c.stroke();
    c.restore();
  }

  /** The round rotate knob with a circular-arrow glyph (Canva-style), at a page point. */
  rotateKnob(at: Point, r: number, active = false): void {
    const p = this.s(at);
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fillStyle = active ? this.theme.selection : "#ffffff";
    c.shadowColor = "rgba(0, 0, 0, 0.3)";
    c.shadowBlur = 4;
    c.shadowOffsetY = 1;
    c.fill();
    c.shadowColor = "transparent";
    c.shadowBlur = 0;
    c.shadowOffsetY = 0;
    c.lineWidth = 1;
    c.strokeStyle = "rgba(0, 0, 0, 0.12)";
    c.stroke();
    // Circular arrow: an open arc swept clockwise, with a filled arrowhead at its end.
    const g = r * 0.45;
    const from = -Math.PI * 0.9;
    const to = Math.PI * 0.45;
    const ink = active ? this.theme.ink : "#171717";
    c.beginPath();
    c.arc(p.x, p.y, g, from, to);
    c.lineWidth = 1.6;
    c.lineCap = "round";
    c.strokeStyle = ink;
    c.stroke();
    const nx = Math.cos(to);
    const ny = Math.sin(to);
    const ex = p.x + g * nx;
    const ey = p.y + g * ny;
    // Tangent along the sweep (increasing angle) and the arrowhead size.
    const tx = -ny;
    const ty = nx;
    const a = g * 0.8;
    c.beginPath();
    c.moveTo(ex + tx * a * 0.7, ey + ty * a * 0.7);
    c.lineTo(ex - tx * a * 0.35 + nx * a * 0.65, ey - ty * a * 0.35 + ny * a * 0.65);
    c.lineTo(ex - tx * a * 0.35 - nx * a * 0.65, ey - ty * a * 0.35 - ny * a * 0.65);
    c.closePath();
    c.fillStyle = ink;
    c.fill();
    c.restore();
  }

  /** A round handle (endpoints, radius, pen anchors). */
  roundHandle(
    at: Point,
    opts: { r?: number; fill?: string; stroke?: string; active?: boolean; screen?: boolean } = {},
  ): void {
    const p = opts.screen ? at : this.s(at);
    const c = this.ctx;
    const r = opts.r ?? 4.5;
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fillStyle = opts.active ? this.theme.selection : (opts.fill ?? "#ffffff");
    c.shadowColor = "rgba(0, 0, 0, 0.35)";
    c.shadowBlur = 3;
    c.fill();
    c.shadowColor = "transparent";
    c.lineWidth = 1.25;
    c.strokeStyle = opts.stroke ?? this.theme.selection;
    c.stroke();
  }

  /** A diamond handle (gap / count handles). */
  diamondHandle(at: Point, opts: { size?: number; active?: boolean } = {}): void {
    const p = this.s(at);
    const c = this.ctx;
    const s = (opts.size ?? 9) / 2;
    c.beginPath();
    c.moveTo(p.x, p.y - s);
    c.lineTo(p.x + s, p.y);
    c.lineTo(p.x, p.y + s);
    c.lineTo(p.x - s, p.y);
    c.closePath();
    c.fillStyle = opts.active ? this.theme.selection : "#ffffff";
    c.shadowColor = "rgba(0, 0, 0, 0.35)";
    c.shadowBlur = 3;
    c.fill();
    c.shadowColor = "transparent";
    c.lineWidth = 1.25;
    c.strokeStyle = this.theme.selection;
    c.stroke();
  }

  /**
   * A pill label at a screen point (centered). `tone` `sun` for sizes / selection info, `measure` for
   * distances, `neutral` for hints.
   */
  label(
    text: string,
    at: Point,
    opts: { tone?: "sun" | "measure" | "neutral"; align?: "center" | "below" | "above" } = {},
  ): { w: number; h: number } {
    const c = this.ctx;
    c.font = `500 11px ${this.theme.fontSans}`;
    const metrics = c.measureText(text);
    const w = Math.ceil(metrics.width) + 12;
    const h = 18;
    let x = at.x - w / 2;
    let y = at.y - h / 2;
    if (opts.align === "below") y = at.y;
    if (opts.align === "above") y = at.y - h;
    x = Math.round(x);
    y = Math.round(y);
    const tone = opts.tone ?? "sun";
    c.beginPath();
    c.roundRect(x, y, w, h, 5);
    c.fillStyle =
      tone === "sun"
        ? this.theme.selection
        : tone === "measure"
          ? this.theme.measure
          : this.theme.dark
            ? "rgba(23, 23, 23, 0.92)"
            : "rgba(255, 255, 255, 0.95)";
    c.shadowColor = "rgba(0, 0, 0, 0.3)";
    c.shadowBlur = 6;
    c.shadowOffsetY = 1;
    c.fill();
    c.shadowColor = "transparent";
    c.shadowBlur = 0;
    c.shadowOffsetY = 0;
    c.fillStyle =
      tone === "sun" ? this.theme.ink : tone === "measure" ? "#ffffff" : this.theme.foreground;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, x + w / 2, y + h / 2 + 0.5);
    return { w, h };
  }

  /** Fills a page-space polygon. */
  fillPolygon(points: readonly Point[], color: string): void {
    this.polygon(points);
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  /** Maps a box-local point to screen. */
  local(m: Matrix, p: Point): Point {
    return this.s(apply(m, p));
  }
}

/** Formats a measurement: integers stay integers, otherwise one decimal. */
export function fmtNum(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
