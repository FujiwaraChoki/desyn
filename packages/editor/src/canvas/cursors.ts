/**
 * Canvas cursors. Resize and rotate cursors follow the selection's rotation exactly (SVG cursors rotated in
 * 5° steps, cached), with the standard CSS cursor as fallback. Drawing tools use a crosshair, the pen a pen nib.
 */

const cache = new Map<string, string>();

function svgCursor(svg: string, hotX: number, hotY: number, fallback: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}

function bucket(deg: number): number {
  const d = (((Math.round(deg / 5) * 5) % 360) + 360) % 360;
  return d;
}

function cssResize(deg: number): string {
  const d = (((Math.round(deg / 45) * 45) % 180) + 180) % 180;
  if (d === 0) return "ew-resize";
  if (d === 45) return "nwse-resize";
  if (d === 90) return "ns-resize";
  return "nesw-resize";
}

/** Double-arrow resize cursor along `deg` (0 = horizontal). */
export function resizeCursor(deg: number): string {
  const d = bucket(deg);
  const key = `r${d}`;
  let c = cache.get(key);
  if (!c) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
      `<g transform="rotate(${d} 12 12)">` +
      `<path d="M3.5 12 L8 7.5 L8 10.5 L16 10.5 L16 7.5 L20.5 12 L16 16.5 L16 13.5 L8 13.5 L8 16.5 Z" ` +
      `fill="#111" stroke="#fff" stroke-width="1.25" stroke-linejoin="round"/></g></svg>`;
    c = svgCursor(svg, 12, 12, cssResize(d));
    cache.set(key, c);
  }
  return c;
}

/** Curved-arrow rotate cursor for a corner; `deg` is the corner's outward direction. */
export function rotateCursor(deg: number): string {
  const d = bucket(deg);
  const key = `o${d}`;
  let c = cache.get(key);
  if (!c) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
      `<g transform="rotate(${d + 45} 12 12)">` +
      `<path d="M6.2 15.2 A7.2 7.2 0 0 1 15.2 6.2 L14.7 3.6 L19.6 7.7 L13.8 10 L14.4 7.9 A5.4 5.4 0 0 0 7.9 14.4 L10 13.8 L7.7 19.6 L3.6 14.7 Z" ` +
      `fill="#111" stroke="#fff" stroke-width="1.15" stroke-linejoin="round"/></g></svg>`;
    c = svgCursor(svg, 12, 12, "grab");
    cache.set(key, c);
  }
  return c;
}

/** Pen nib; `variant` adds a badge: `close` (closing a path), `add`, `remove`, `convert`. */
export function penCursor(
  variant: "none" | "close" | "add" | "remove" | "convert" = "none",
): string {
  const key = `p${variant}`;
  let c = cache.get(key);
  if (!c) {
    const badge =
      variant === "close"
        ? `<circle cx="18.5" cy="18.5" r="2.6" fill="#fff" stroke="#111" stroke-width="1.2"/>`
        : variant === "add"
          ? `<path d="M18.5 15.5v6M15.5 18.5h6" stroke="#111" stroke-width="1.6" stroke-linecap="round"/>`
          : variant === "remove"
            ? `<path d="M15.5 18.5h6" stroke="#111" stroke-width="1.6" stroke-linecap="round"/>`
            : variant === "convert"
              ? `<path d="M15.5 21.5 L18.5 15.5 L21.5 21.5" fill="none" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>`
              : "";
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
      `<path d="M2 2 L6.5 13 L10 15.5 L15.5 10 L13 6.5 Z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<circle cx="8.6" cy="8.6" r="1.4" fill="#fff"/>${badge}</svg>`;
    c = svgCursor(svg, 2, 2, "crosshair");
    cache.set(key, c);
  }
  return c;
}

export const CURSORS = {
  default: "default",
  crosshair: "crosshair",
  text: "text",
  grab: "grab",
  grabbing: "grabbing",
  move: "move",
  copy: "copy",
  pointer: "pointer",
  notAllowed: "not-allowed",
  comment: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">` +
      `<path d="M3 23 L3 11 A8 8 0 1 1 11 19 Z" fill="#ffb02e" stroke="#1a1205" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    3,
    23,
    "crosshair",
  ),
  pencil: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
      `<path d="M3 21 L4.2 16.4 L16.6 4 A1.6 1.6 0 0 1 18.9 4 L20 5.1 A1.6 1.6 0 0 1 20 7.4 L7.6 19.8 Z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<path d="M3 21 L4.2 16.4 L7.6 19.8 Z" fill="#ffb02e"/></svg>`,
    3,
    21,
    "crosshair",
  ),
} as const;
