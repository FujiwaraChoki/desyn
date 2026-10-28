// Downloads the Google Fonts (OFL) a set of families needs into templates/.fonts (gitignored), so thumbnails and the
// engine relayout use the real faces. Static instances per weight (and italic when the family has one) are fetched
// as TTF through the CSS2 API.
//   pnpm --filter @desyn/templates fonts [family ...]   (default: every family the pairings use)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getFont } from "@desyn/schema";
import { FONTS_DIR } from "../lib/paths";
import { PAIRS } from "../lib/type";

/** Families every template may use beyond the pairings. */
const EXTRA = ["Inter", "JetBrains Mono"];

export function familiesNeeded(): string[] {
  const set = new Set<string>(EXTRA);
  for (const p of PAIRS) {
    set.add(p.heading);
    set.add(p.body);
  }
  return [...set].sort();
}

function slug(family: string): string {
  return family.replace(/[^A-Za-z0-9]+/g, "");
}

export async function ensureFamily(family: string): Promise<number> {
  const info = getFont(family);
  if (!info) throw new Error(`${family} is not in the font catalog`);
  const weights = info.weights.filter((w) => [300, 400, 500, 600, 700, 800, 900].includes(w));
  const styles: [number, number][] = [];
  for (const w of weights.length ? weights : info.weights) {
    styles.push([0, w]);
    if (info.italic) styles.push([1, w]);
  }
  const dir = join(FONTS_DIR, slug(family));
  const marker = join(dir, ".complete");
  if (existsSync(marker)) return 0;
  mkdirSync(dir, { recursive: true });
  const axis = info.italic ? "ital,wght" : "wght";
  const tuples = styles
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([i, w]) => (info.italic ? `${i},${w}` : `${w}`))
    .join(";");
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:${axis}@${tuples}`;
  // An old user agent makes the CSS API answer with TTF sources instead of WOFF2 subsets.
  const css = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/534.30" },
  });
  if (!css.ok) throw new Error(`Google Fonts CSS ${css.status} for ${family}`);
  const text = await css.text();
  const faces = [
    ...text.matchAll(/font-style:\s*(\w+);\s*font-weight:\s*(\d+);[^}]*?src:\s*url\(([^)]+)\)/g),
  ];
  let n = 0;
  for (const [, style, weight, src] of faces) {
    if (!src) continue;
    const file = join(dir, `${slug(family)}-${weight}${style === "italic" ? "i" : ""}.ttf`);
    if (existsSync(file)) continue;
    const res = await fetch(src);
    if (!res.ok) throw new Error(`font download ${res.status} for ${family} ${weight}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    n++;
  }
  if (faces.length === 0) throw new Error(`no faces for ${family}`);
  writeFileSync(marker, "");
  return n;
}

async function main(): Promise<void> {
  const families = process.argv.slice(2).length ? process.argv.slice(2) : familiesNeeded();
  let total = 0;
  for (const f of families) {
    const n = await ensureFamily(f);
    total += n;
    if (n) console.log(`  ${f}: ${n} file(s)`);
  }
  console.log(`${families.length} families ready in ${FONTS_DIR} (${total} new files)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
