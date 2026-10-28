// Regenerates assets/presets.json from @desyn/schema's PAGE_PRESETS (the single source of page sizes), so the
// desktop "New design" picker offers exactly the sizes the web app offers.
// Usage (repo root): node apps/desktop/scripts/gen-presets.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { PAGE_PRESETS } = await import(
  join(here, "..", "..", "..", "packages", "schema", "src", "presets.ts")
);
const out = PAGE_PRESETS.map((p) => ({
  id: p.id,
  label: p.label,
  kind: p.kind,
  category: p.category,
  platform: p.platform ?? null,
  width: p.width,
  height: p.height,
  unit: p.unit,
  bleed: p.bleed ?? 0,
}));
writeFileSync(join(here, "..", "assets", "presets.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${out.length} presets`);
