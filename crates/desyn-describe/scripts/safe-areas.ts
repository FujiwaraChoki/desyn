// Prints the `SAFE_AREA_PRESETS` rows of crates/desyn-describe/src/kinds.rs from the @desyn/schema page presets.
// Run from the repo root: packages/schema/node_modules/.bin/tsx crates/desyn-describe/scripts/safe-areas.ts
import { PAGE_PRESETS } from "../../../packages/schema/src/presets.ts";

const variant = (kind: string) =>
  kind
    .split("-")
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1))
    .join("");
const n = (v: number) => v.toFixed(2);

for (const p of PAGE_PRESETS) {
  const s = p.safeArea;
  if (!s) continue;
  console.log(
    `    ("${p.id}", DesignKind::${variant(p.kind)}, ${n(p.width)}, ${n(p.height)}, [${[s.top, s.right, s.bottom, s.left].map(n).join(", ")}]),`,
  );
}
