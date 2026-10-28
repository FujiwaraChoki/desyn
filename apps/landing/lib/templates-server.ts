import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ManifestEntry, parseManifest } from "./templates";

/** Reads templates/manifest.json at build time if the templates pipeline has produced one. */
export async function loadTemplateManifest(): Promise<ManifestEntry[]> {
  const candidates = [
    join(process.cwd(), "..", "..", "templates", "manifest.json"),
    join(process.cwd(), "templates", "manifest.json"),
  ];
  for (const file of candidates) {
    try {
      // Build-time only (the page is static): keep the file out of server tracing.
      const raw = await readFile(/*turbopackIgnore: true*/ file, "utf8");
      // Previews copied by scripts/copy-template-previews.mjs replace the pipeline's relative thumbnail paths.
      const previews = join(process.cwd(), "public", "template-previews");
      return parseManifest(JSON.parse(raw)).map((m) =>
        m.thumbnail === null &&
        existsSync(/*turbopackIgnore: true*/ join(previews, `${m.slug}.webp`))
          ? { ...m, thumbnail: `/template-previews/${m.slug}.webp` }
          : m,
      );
    } catch {
      // Missing or unreadable: try the next location, then fall back to generated previews.
    }
  }
  return [];
}
