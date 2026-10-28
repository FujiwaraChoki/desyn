// Procedural vector art: decorative SVG drawn from the template's own palette, so every illustration is original
// (no stock, no copyright questions) and recolors with the design. Each generator returns SVG markup with a viewBox
// matching the requested box; markup uses only elements the server-side sanitizer allows (path, circle, rect, g,
// linearGradient, stop).
import { between, pick, type Rng } from "./rand";

const f = (n: number) => (Math.round(n * 10) / 10).toString();

function svg(w: number, h: number, body: string, defs = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(w)} ${f(h)}" width="${f(w)}" height="${f(h)}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}

/** Smooth closed blob through n points around a center (Catmull-Rom converted to cubic Béziers). */
export function blobPath(
  r: Rng,
  cx: number,
  cy: number,
  radius: number,
  n = 7,
  wobble = 0.22,
): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = radius * (1 + between(r, -wobble, wobble));
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  const at = (k: number): [number, number] => pts[((k % n) + n) % n] ?? [cx, cy];
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

export function blobs(r: Rng, w: number, h: number, colors: string[], count = 3): string {
  let body = "";
  for (let i = 0; i < count; i++) {
    const c = colors[i % colors.length] ?? "#000000";
    const rad = Math.min(w, h) * between(r, 0.22, 0.42);
    body += `<path d="${blobPath(r, between(r, rad, w - rad), between(r, rad, h - rad), rad)}" fill="${c}" opacity="${f(between(r, 0.55, 0.95))}"/>`;
  }
  return svg(w, h, body);
}

/** Sun on a horizon with rays: the Desyn motif. */
export function sunrise(w: number, h: number, sun: string, glow: string, rays = 14): string {
  const cx = w / 2;
  const cy = h * 0.82;
  const rad = Math.min(w * 0.36, h * 0.6);
  let body = "";
  for (let i = 0; i < rays; i++) {
    const a = Math.PI + (i + 0.5) * (Math.PI / rays);
    const a2 = a + Math.PI / rays / 2.6;
    const R = Math.hypot(w, h);
    body += `<path d="M${f(cx)} ${f(cy)} L${f(cx + Math.cos(a) * R)} ${f(cy + Math.sin(a) * R)} L${f(cx + Math.cos(a2) * R)} ${f(cy + Math.sin(a2) * R)}Z" fill="${glow}" opacity="0.16"/>`;
  }
  body += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rad * 1.25)}" fill="${glow}" opacity="0.22"/>`;
  body += `<path d="M${f(cx - rad)} ${f(cy)} A${f(rad)} ${f(rad)} 0 0 1 ${f(cx + rad)} ${f(cy)}Z" fill="url(#sun)"/>`;
  body += `<rect x="0" y="${f(cy)}" width="${f(w)}" height="${f(h - cy)}" fill="${glow}" opacity="0.08"/>`;
  const defs = `<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${glow}"/><stop offset="1" stop-color="${sun}"/></linearGradient>`;
  return svg(w, h, body, defs);
}

/** Bauhaus tiles: a grid of circles, half and quarter discs. */
export function bauhaus(r: Rng, w: number, h: number, colors: string[], cols = 4): string {
  const size = w / cols;
  const rows = Math.ceil(h / size);
  let body = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = x * size;
      const py = y * size;
      const c = pick(r, colors);
      const kind = Math.floor(r() * 5);
      const s = f(size);
      if (kind === 0)
        body += `<circle cx="${f(px + size / 2)}" cy="${f(py + size / 2)}" r="${f(size / 2)}" fill="${c}"/>`;
      else if (kind === 1)
        body += `<path d="M${f(px)} ${f(py + size)} A${f(size)} ${f(size)} 0 0 1 ${f(px + size)} ${f(py)} L${f(px + size)} ${f(py + size)}Z" fill="${c}"/>`;
      else if (kind === 2)
        body += `<path d="M${f(px)} ${f(py + size / 2)} A${f(size / 2)} ${f(size / 2)} 0 0 1 ${f(px + size)} ${f(py + size / 2)}Z" fill="${c}"/>`;
      else if (kind === 3)
        body += `<rect x="${f(px)}" y="${f(py)}" width="${s}" height="${s}" fill="${c}"/>`;
      else
        body += `<path d="M${f(px)} ${f(py)} L${f(px + size)} ${f(py)} L${f(px)} ${f(py + size)}Z" fill="${c}"/>`;
    }
  }
  return svg(w, h, body);
}

/** Layered waves at the bottom of the box. */
export function waves(r: Rng, w: number, h: number, colors: string[]): string {
  let body = "";
  colors.forEach((c, i) => {
    const base = h * (0.35 + (i / colors.length) * 0.5);
    const amp = h * between(r, 0.05, 0.12);
    const k = between(r, 1.2, 2.4);
    const ph = r() * Math.PI * 2;
    let d = `M0 ${f(h)} L0 ${f(base)}`;
    for (let x = 0; x <= w; x += w / 24)
      d += ` L${f(x)} ${f(base + Math.sin((x / w) * Math.PI * 2 * k + ph) * amp)}`;
    d += ` L${f(w)} ${f(h)}Z`;
    body += `<path d="${d}" fill="${c}"/>`;
  });
  return svg(w, h, body);
}

/** Dot grid. */
export function dots(w: number, h: number, color: string, step: number, radius: number): string {
  let body = "";
  for (let y = step / 2; y < h; y += step)
    for (let x = step / 2; x < w; x += step)
      body += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(radius)}"/>`;
  return svg(w, h, `<g fill="${color}">${body}</g>`);
}

/** Concentric rings. */
export function rings(w: number, h: number, color: string, count: number, stroke: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const max = Math.min(w, h) / 2 - stroke;
  let body = "";
  for (let i = 1; i <= count; i++)
    body += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f((max * i) / count)}"/>`;
  return svg(w, h, `<g fill="none" stroke="${color}" stroke-width="${f(stroke)}">${body}</g>`);
}

/** Stacked arches (rainbow / doorway). */
export function arches(w: number, h: number, colors: string[]): string {
  let body = "";
  const n = colors.length;
  colors.forEach((c, i) => {
    const inset = (i * w) / (2 * n + 1);
    const aw = w - inset * 2;
    const r = aw / 2;
    const top = inset + 0;
    body += `<path d="M${f(inset)} ${f(h)} L${f(inset)} ${f(top + r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - inset)} ${f(top + r)} L${f(w - inset)} ${f(h)}Z" fill="${c}"/>`;
  });
  return svg(w, h, body);
}

/** Botanical sprig: a curved stem with paired leaves. */
export function sprig(r: Rng, w: number, h: number, color: string, leaves = 7): string {
  const x0 = w * 0.5;
  const bend = w * between(r, -0.18, 0.18);
  const stem = `M${f(x0)} ${f(h)} Q${f(x0 + bend)} ${f(h * 0.5)} ${f(x0)} ${f(h * 0.04)}`;
  let body = `<path d="${stem}" fill="none" stroke="${color}" stroke-width="${f(Math.max(1.5, w * 0.012))}" stroke-linecap="round"/>`;
  for (let i = 1; i <= leaves; i++) {
    const t = i / (leaves + 1);
    const y = h - t * h * 0.96;
    const x = x0 + bend * 2 * t * (1 - t);
    const len = w * 0.32 * (1 - t * 0.45);
    for (const side of [-1, 1]) {
      const tipX = x + side * len;
      const tipY = y - len * 0.55;
      body += `<path d="M${f(x)} ${f(y)} Q${f(x + side * len * 0.5)} ${f(y - len * 0.75)} ${f(tipX)} ${f(tipY)} Q${f(x + side * len * 0.6)} ${f(y - len * 0.05)} ${f(x)} ${f(y)}Z" fill="${color}"/>`;
    }
  }
  return svg(w, h, body);
}

/** Confetti: small rotated rectangles, circles and squiggles. */
export function confetti(r: Rng, w: number, h: number, colors: string[], count = 40): string {
  let body = "";
  const s = Math.min(w, h);
  for (let i = 0; i < count; i++) {
    const c = pick(r, colors);
    const x = r() * w;
    const y = r() * h;
    const k = r();
    if (k < 0.45) {
      const lw = s * between(r, 0.012, 0.025);
      const lh = lw * between(r, 2, 3.2);
      body += `<rect x="${f(x)}" y="${f(y)}" width="${f(lw)}" height="${f(lh)}" rx="${f(lw / 3)}" fill="${c}" transform="rotate(${f(r() * 180)} ${f(x)} ${f(y)})"/>`;
    } else if (k < 0.8)
      body += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s * between(r, 0.006, 0.014))}" fill="${c}"/>`;
    else {
      const len = s * 0.05;
      body += `<path d="M${f(x)} ${f(y)} q${f(len / 4)} ${f(-len / 3)} ${f(len / 2)} 0 t${f(len / 2)} 0" fill="none" stroke="${c}" stroke-width="${f(s * 0.007)}" stroke-linecap="round"/>`;
    }
  }
  return svg(w, h, body);
}

/** Four-point sparkle star path inside a box. */
export function sparkle(w: number, h: number, color: string): string {
  const cx = w / 2;
  const cy = h / 2;
  const d = `M${f(cx)} 0 C${f(cx * 1.08)} ${f(cy * 0.92)} ${f(w - cx * 0.92 + cx * 0.0)} ${f(cy * 0.92)} ${f(w)} ${f(cy)} C${f(cx * 1.08)} ${f(cy * 1.08)} ${f(cx * 1.08)} ${f(cy * 1.08)} ${f(cx)} ${f(h)} C${f(cx * 0.92)} ${f(cy * 1.08)} ${f(cx * 0.92)} ${f(cy * 1.08)} 0 ${f(cy)} C${f(cx * 0.92)} ${f(cy * 0.92)} ${f(cx * 0.92)} ${f(cy * 0.92)} ${f(cx)} 0Z`;
  return svg(w, h, `<path d="${d}" fill="${color}"/>`);
}

/** Layered mountain ridges (travel, outdoors). */
export function ridges(r: Rng, w: number, h: number, colors: string[]): string {
  let body = "";
  colors.forEach((c, i) => {
    const base = h * (0.3 + (i / colors.length) * 0.55);
    let d = `M0 ${f(h)} L0 ${f(base)}`;
    let x = 0;
    while (x < w) {
      const step = w * between(r, 0.08, 0.2);
      const peak = base - h * between(r, 0.05, 0.25);
      d += ` L${f(x + step / 2)} ${f(peak)} L${f(Math.min(w, x + step))} ${f(base + h * between(r, -0.04, 0.06))}`;
      x += step;
    }
    d += ` L${f(w)} ${f(h)}Z`;
    body += `<path d="${d}" fill="${c}"/>`;
  });
  return svg(w, h, body);
}

/** A hand-drawn style underline swash. */
export function swash(w: number, h: number, color: string): string {
  return svg(
    w,
    h,
    `<path d="M${f(w * 0.02)} ${f(h * 0.7)} C${f(w * 0.3)} ${f(h * 0.15)} ${f(w * 0.7)} ${f(h * 0.2)} ${f(w * 0.98)} ${f(h * 0.45)}" fill="none" stroke="${color}" stroke-width="${f(h * 0.22)}" stroke-linecap="round"/>`,
  );
}

/** Simple line icons drawn on a 24-unit grid (stroke icons, Lucide-like proportions; original drawings). */
export const ICONS: Record<string, string> = {
  calendar: `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  pin: `<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  phone: `<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>`,
  mail: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>`,
  globe: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7"/>`,
  star: `<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>`,
  heart: `<path d="M12 20s-7.5-4.6-9-9.4C2 6.9 4.6 4 7.6 4c1.9 0 3.4 1 4.4 2.6C13 5 14.5 4 16.4 4 19.4 4 22 6.9 21 10.6 19.5 15.4 12 20 12 20z"/>`,
  arrow: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
  spark: `<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>`,
  leaf: `<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19c3-4 6-7 10-9"/>`,
  cup: `<path d="M4 8h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2c-1 1.5 1 2.5 0 4M12 2c-1 1.5 1 2.5 0 4"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>`,
  chart: `<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`,
  bolt: `<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>`,
  ticket: `<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3z" transform="translate(0 2)"/><path d="M14 6v12" stroke-dasharray="2 2"/>`,
  music: `<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>`,
  camera: `<path d="M4 7h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="4"/>`,
  home: `<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>`,
  book: `<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>`,
  gift: `<rect x="3" y="8" width="18" height="5"/><path d="M5 13v8h14v-8M12 8v13M12 8C9 8 7 4 9.5 3.5S12 8 12 8s.5-5 2.5-4.5S15 8 12 8"/>`,
  shield: `<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>`,
};

export function icon(name: string, color: string, size: number, stroke = 1.75): string {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon ${name}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${f(size)}" height="${f(size)}"><g fill="none" stroke="${color}" stroke-width="${f(stroke)}" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
}

/** Monogram logo mark: a letter in a shape (used for placeholder brand marks). */
export function monogram(
  letter: string,
  shape: "circle" | "square" | "arch",
  bg: string,
  fg: string,
  size: number,
  family: string,
): string {
  const s = f(size);
  const half = f(size / 2);
  const back =
    shape === "circle"
      ? `<circle cx="${half}" cy="${half}" r="${half}" fill="${bg}"/>`
      : shape === "square"
        ? `<rect width="${s}" height="${s}" rx="${f(size * 0.22)}" fill="${bg}"/>`
        : `<path d="M0 ${s} L0 ${half} A${half} ${half} 0 0 1 ${s} ${half} L${s} ${s}Z" fill="${bg}"/>`;
  const escaped = letter.replace(/[<>&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">${back}<text x="${half}" y="${f(size * 0.68)}" text-anchor="middle" font-family="${family.replace(/"/g, "")}" font-size="${f(size * 0.52)}" fill="${fg}">${escaped}</text></svg>`;
}
