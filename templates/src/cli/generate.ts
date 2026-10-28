// Builds every template in the plan, normalizes it with the real engine, validates it against the contract and
// writes templates/designs/<slug>.json plus templates/manifest.json.
//   pnpm --filter @desyn/templates generate [--only slug-prefix] [--strict]
// --strict fails on any lint issue of severity "error".
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, type Design, validateDesign } from "@desyn/schema";
import type { TemplateSpec } from "../catalog";
import { setImageResolver } from "../lib/doc";
import { Normalizer } from "../lib/engine";
import { DESIGNS_DIR, MANIFEST, readImageManifest } from "../lib/paths";
import { PLAN } from "../plan";

export interface ManifestEntry {
  slug: string;
  title: string;
  description: string;
  kind: string;
  preset: string;
  width: number;
  height: number;
  pages: number;
  category: string;
  categories: string[];
  tags: string[];
  premium: boolean;
  collections: string[];
  searchText: string;
  colors: string[];
  fonts: string[];
  images: string[];
  thumbnail: string;
  niche: string;
  archetype: string;
  palette: string;
}

function textOf(d: Design): string {
  const parts: string[] = [];
  for (const n of Object.values(d.nodes)) {
    if (n.type === "text") parts.push(n.runs.map((r) => r.text).join(""));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function fontsOf(d: Design): string[] {
  const set = new Set<string>();
  for (const n of Object.values(d.nodes)) {
    if (n.type === "text") {
      set.add(n.style.fontFamily);
      for (const r of n.runs) if (r.style?.fontFamily) set.add(r.style.fontFamily);
    }
  }
  return [...set].sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
  const strict = args.includes("--strict");
  const images = readImageManifest();
  setImageResolver((key) => {
    const img = images[key];
    if (!img) throw new Error(`image "${key}" has not been generated (run: pnpm imagery)`);
    return { key, ...img };
  });
  const specs: TemplateSpec[] = PLAN().filter((s) => !only || s.slug.startsWith(only));
  mkdirSync(DESIGNS_DIR, { recursive: true });
  if (!only) for (const f of readdirSync(DESIGNS_DIR)) rmSync(join(DESIGNS_DIR, f));
  const normalizer = await Normalizer.create();
  const manifest: ManifestEntry[] = [];
  const problems: string[] = [];
  const issueCounts = new Map<string, number>();
  for (const spec of specs) {
    const doc = spec.build();
    const pre = validateDesign(doc.design);
    if (!pre.ok) {
      problems.push(
        `${spec.slug}: invalid before normalize: ${pre.errors
          .slice(0, 3)
          .map((e) => `${e.path.join(".")} ${e.message}`)
          .join("; ")}`,
      );
      continue;
    }
    const { design, issues, missingFonts } = normalizer.normalize(doc.design);
    const post = validateDesign(design);
    if (!post.ok) {
      problems.push(
        `${spec.slug}: invalid after normalize: ${post.errors
          .slice(0, 3)
          .map((e) => `${e.path.join(".")} ${e.message}`)
          .join("; ")}`,
      );
      continue;
    }
    if (missingFonts.length)
      problems.push(`${spec.slug}: missing fonts ${missingFonts.join(", ")}`);
    for (const { issue } of issues)
      issueCounts.set(
        `${issue.severity}:${issue.code}`,
        (issueCounts.get(`${issue.severity}:${issue.code}`) ?? 0) + 1,
      );
    const errors = issues.filter((i) => i.issue.severity === "error");
    if (errors.length && strict)
      problems.push(
        `${spec.slug}: ${errors.map((e) => `p${e.page} ${e.issue.code} ${e.issue.message}`).join(" | ")}`,
      );
    design.meta = { ...design.meta, createdAt: 0, updatedAt: 0 };
    writeFileSync(join(DESIGNS_DIR, `${spec.slug}.json`), `${canonicalize(design)}\n`);
    const pages = (design.nodes.root as unknown as { children: string[] }).children.length;
    manifest.push({
      slug: spec.slug,
      title: spec.title,
      description: spec.description,
      kind: spec.kind,
      preset: spec.preset,
      width: doc.width,
      height: doc.height,
      pages,
      category: spec.category,
      categories: spec.categories,
      tags: spec.tags,
      premium: spec.premium,
      collections: spec.collections,
      searchText: `${spec.title} ${spec.tags.join(" ")} ${textOf(design)}`.slice(0, 2000),
      colors: Object.values(design.styles.colors).map((c) => c.value),
      fonts: fontsOf(design),
      images: [...doc.images],
      thumbnail: `thumbnails/${spec.slug}.webp`,
      niche: spec.niche,
      archetype: spec.archetype,
      palette: spec.palette,
    });
  }
  // A partial run (--only) merges its entries into the existing manifest.
  const merged =
    only && existsSync(MANIFEST)
      ? [
          ...(JSON.parse(readFileSync(MANIFEST, "utf8")) as ManifestEntry[]).filter(
            (m) => !manifest.some((x) => x.slug === m.slug),
          ),
          ...manifest,
        ].sort((a, b) => a.slug.localeCompare(b.slug))
      : manifest;
  writeFileSync(MANIFEST, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`${manifest.length}/${specs.length} templates written`);
  const byKind = new Map<string, number>();
  for (const m of manifest) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
  console.log([...byKind].map(([k, n]) => `${k} ${n}`).join(", "));
  if (issueCounts.size)
    console.log(
      `lint: ${[...issueCounts]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ×${n}`)
        .join(", ")}`,
    );
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
