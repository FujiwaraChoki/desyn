// Renders thumbnails (WebP, 640 px on the long side), page previews for multi-page templates and the small gallery
// previews in templates/public with the desyn-render CLI (crates/desyn-raster) and the downloaded fonts.
//   pnpm --filter @desyn/templates render [--only slug-prefix] [--jobs 8]
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Design } from "@desyn/schema";
import {
  DESIGNS_DIR,
  FONTS_DIR,
  IMAGES_DIR,
  MANIFEST,
  PUBLIC_DIR,
  RENDERS_DIR,
  REPO,
  readImageManifest,
  THUMBS_DIR,
} from "../lib/paths";
import type { ManifestEntry } from "./generate";

const run = promisify(execFile);
const BIN = join(REPO, "target/render/release/desyn-render");

async function renderOne(
  entry: ManifestEntry,
  images: ReturnType<typeof readImageManifest>,
): Promise<void> {
  const designPath = join(DESIGNS_DIR, `${entry.slug}.json`);
  const design = JSON.parse(readFileSync(designPath, "utf8")) as Design;
  // Asset directory: <assetId>.<ext> symlinks to the imagery files.
  const assets = join(RENDERS_DIR, "assets", entry.slug);
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  for (const a of Object.values(design.assets)) {
    const img = a.name ? images[a.name] : undefined;
    if (img) symlinkSync(join(IMAGES_DIR, img.file), join(assets, `${a.id}.jpg`));
  }
  const long = Math.max(entry.width, entry.height);
  const scale = (thumb: number) => (thumb / long).toFixed(4);
  const base = ["--assets", assets, "--fonts", FONTS_DIR];
  const full = join(RENDERS_DIR, `${entry.slug}.png`);
  await run(BIN, [designPath, ...base, "-p", "0", "-s", scale(1280), "-o", full]);
  await run("magick", [
    full,
    "-resize",
    "640x640>",
    "-quality",
    "82",
    "-define",
    "webp:method=6",
    join(THUMBS_DIR, `${entry.slug}.webp`),
  ]);
  await run("magick", [
    full,
    "-resize",
    "560x560>",
    "-quality",
    "78",
    "-define",
    "webp:method=6",
    join(PUBLIC_DIR, `${entry.slug}.webp`),
  ]);
  if (entry.pages > 1) {
    const dir = join(THUMBS_DIR, entry.slug);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < entry.pages; i++) {
      const page = join(RENDERS_DIR, `${entry.slug}-p${i}.png`);
      await run(BIN, [designPath, ...base, "-p", String(i), "-s", scale(960), "-o", page]);
      await run("magick", [
        page,
        "-resize",
        "480x480>",
        "-quality",
        "80",
        join(dir, `${i + 1}.webp`),
      ]);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
  const jobs = Number(args.includes("--jobs") ? args[args.indexOf("--jobs") + 1] : 8);
  if (!existsSync(BIN))
    throw new Error(
      `build the renderer first: CARGO_TARGET_DIR=target/render cargo build --release -p desyn-raster --features cli --bin desyn-render`,
    );
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as ManifestEntry[];
  const images = readImageManifest();
  for (const d of [THUMBS_DIR, PUBLIC_DIR, RENDERS_DIR]) mkdirSync(d, { recursive: true });
  const todo = manifest.filter((m) => !only || m.slug.startsWith(only));
  let done = 0;
  const failures: string[] = [];
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        try {
          await renderOne(e, images);
        } catch (err) {
          failures.push(
            `${e.slug}: ${err instanceof Error ? err.message.split("\n").slice(0, 3).join(" ") : String(err)}`,
          );
        }
        done++;
        if (done % 25 === 0) console.log(`  ${done}/${todo.length}`);
      }
    }),
  );
  console.log(`rendered ${todo.length - failures.length}/${todo.length}`);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
