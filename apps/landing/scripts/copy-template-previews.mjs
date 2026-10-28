// Copies the template pipeline's small previews (templates/public/*.webp) into public/template-previews/ so the
// /templates gallery shows the real designs. Runs before `next dev` and `next build`; a missing pipeline output
// leaves the gallery on its generated previews.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const src = join(here, "..", "..", "..", "templates", "public");
const dest = join(here, "..", "public", "template-previews");
rmSync(dest, { recursive: true, force: true });
if (!existsSync(src)) {
  console.log("template previews: templates/public not found, using generated previews");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!/^[a-z0-9-]+\.webp$/.test(f)) continue;
  copyFileSync(join(src, f), join(dest, f));
  n++;
}
console.log(`template previews: ${n} copied`);
