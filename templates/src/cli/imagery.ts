// Generates the missing photos of the imagery catalog with fal (FLUX 3) and records provenance.
//   pnpm --filter @desyn/templates imagery [--only key1,key2] [--dry-run]
//   pnpm --filter @desyn/templates imagery --print   (2x upscales of the photos print templates use)
// FAL_AI_API_KEY is read from the environment or the repo's .env file and is never printed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGERY, type ImagerySpec } from "../imagery";
import { ASSETS_DIR, IMAGES_DIR, type ImageManifest, readImageManifest } from "../lib/paths";

const ENDPOINT = "https://fal.run/blackforestlabs/flux-3/text-to-image";
const UPSCALE = "https://fal.run/fal-ai/seedvr/upscale/image";
/** Kinds printed at 300 dpi: their photos use a 2x upscaled `<key>@print` variant. */
export const PRINT_KINDS = new Set([
  "poster",
  "flyer",
  "book-cover",
  "menu",
  "invitation",
  "certificate",
  "business-card",
  "resume",
  "document",
]);
const PRINT_PRESETS = new Set(["newsletter-a4", "newsletter-letter"]);
const MODEL = "blackforestlabs/flux-3/text-to-image";
const MAX_SIDE = 1800;

function falKey(): string {
  const fromEnv = process.env.FAL_AI_API_KEY;
  if (fromEnv) return fromEnv;
  const envFile = join(import.meta.dirname, "../../../.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^FAL_AI_API_KEY=(.*)$/.exec(line.trim());
      if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("FAL_AI_API_KEY is not set (environment or .env)");
}

async function generate(spec: ImagerySpec, key: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Key ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: spec.prompt,
        aspect_ratio: spec.ratio,
        resolution: "2k",
        output_format: "jpeg",
        safety_tolerance: 2,
      }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 4000 * attempt));
        continue;
      }
      throw new Error(`fal ${res.status} for ${spec.key}: ${text}`);
    }
    const body = (await res.json()) as { images?: { url: string }[] };
    const url = body.images?.[0]?.url;
    if (!url) throw new Error(`fal returned no image for ${spec.key}`);
    const img = await fetch(url);
    if (!img.ok) throw new Error(`download ${img.status} for ${spec.key}`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error(`fal failed for ${spec.key}`);
}

/** 2x upscale of an existing catalog image (same picture, print resolution). */
async function upscale(file: string, key: string): Promise<Buffer> {
  const dataUri = `data:image/jpeg;base64,${readFileSync(file).toString("base64")}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(UPSCALE, {
      method: "POST",
      headers: { authorization: `Key ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        image_url: dataUri,
        upscale_mode: "factor",
        upscale_factor: 2,
        output_format: "png",
      }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 4000 * attempt));
        continue;
      }
      throw new Error(`fal upscale ${res.status}: ${text}`);
    }
    const body = (await res.json()) as { image?: { url: string } };
    const url = body.image?.url;
    if (!url) throw new Error("fal upscale returned no image");
    const img = await fetch(url);
    if (!img.ok) throw new Error(`download ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error("fal upscale failed");
}

/** Images used by print templates in the current manifest. */
function printImages(): string[] {
  const path = join(import.meta.dirname, "../../manifest.json");
  if (!existsSync(path)) return [];
  const entries = JSON.parse(readFileSync(path, "utf8")) as {
    kind: string;
    preset: string;
    images: string[];
  }[];
  const set = new Set<string>();
  for (const e of entries)
    if (PRINT_KINDS.has(e.kind) || PRINT_PRESETS.has(e.preset))
      for (const i of e.images) set.add(i.replace(/@print$/, ""));
  return [...set].sort();
}

async function printVariants(manifest: ImageManifest, key: string, dry: boolean): Promise<void> {
  const todo = printImages().filter(
    (k) =>
      manifest[k] &&
      !(manifest[`${k}@print`] && existsSync(join(IMAGES_DIR, manifest[`${k}@print`]?.file ?? ""))),
  );
  console.log(`${todo.length} print variant(s) to upscale${dry ? " (dry run)" : ""}`);
  if (dry) return;
  const queue = [...todo];
  let done = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let k = queue.shift(); k; k = queue.shift()) {
        const src = manifest[k];
        if (!src) continue;
        const raw = await upscale(join(IMAGES_DIR, src.file), key);
        const file = `${k}@print.jpg`;
        const path = join(IMAGES_DIR, file);
        writeFileSync(`${path}.src`, raw);
        execFileSync("magick", [
          `${path}.src`,
          "-colorspace",
          "sRGB",
          "-strip",
          "-interlace",
          "Plane",
          "-quality",
          "86",
          path,
        ]);
        execFileSync("rm", ["-f", `${path}.src`]);
        const { width, height } = dimensions(path);
        manifest[`${k}@print`] = {
          ...src,
          file,
          width,
          height,
          provenance: {
            ...src.provenance,
            model: `${src.provenance.model} + fal-ai/seedvr/upscale/image (2x)`,
          },
        };
        done++;
        console.log(`  [${done}/${todo.length}] ${k}@print ${width}x${height}`);
        writeFileSync(join(ASSETS_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      }
    }),
  );
}

function dimensions(file: string): { width: number; height: number } {
  const out = execFileSync("magick", ["identify", "-format", "%w %h", file], { encoding: "utf8" });
  const [w, h] = out.trim().split(" ").map(Number);
  return { width: w ?? 0, height: h ?? 0 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const onlyArg = args[args.indexOf("--only") + 1];
  const only = args.includes("--only") && onlyArg ? new Set(onlyArg.split(",")) : null;
  mkdirSync(IMAGES_DIR, { recursive: true });
  const manifest: ImageManifest = readImageManifest();
  if (args.includes("--print")) {
    await printVariants(manifest, dry ? "" : falKey(), dry);
    return;
  }
  const todo = IMAGERY.filter((s) => {
    if (only) return only.has(s.key);
    const have = manifest[s.key];
    return !have || !existsSync(join(IMAGES_DIR, have.file));
  });
  console.log(`${todo.length} image(s) to generate${dry ? " (dry run)" : ""}`);
  if (dry || todo.length === 0) return;
  const key = falKey();
  let done = 0;
  // A few at a time: fal's sync endpoint holds the connection until the image is ready.
  const queue = [...todo];
  const workers = Array.from({ length: 4 }, async () => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      const raw = await generate(spec, key);
      const file = `${spec.key}.jpg`;
      const path = join(IMAGES_DIR, file);
      const tmp = `${path}.src`;
      writeFileSync(tmp, raw);
      // Normalize: sRGB, max 1800 px on the long side, progressive JPEG q84, metadata stripped.
      execFileSync("magick", [
        tmp,
        "-colorspace",
        "sRGB",
        "-resize",
        `${MAX_SIDE}x${MAX_SIDE}>`,
        "-strip",
        "-interlace",
        "Plane",
        "-quality",
        "84",
        path,
      ]);
      execFileSync("rm", ["-f", tmp]);
      const { width, height } = dimensions(path);
      manifest[spec.key] = {
        file,
        width,
        height,
        mime: "image/jpeg",
        alt: spec.alt,
        provenance: { provider: "fal", model: MODEL, prompt: spec.prompt },
      };
      done++;
      console.log(`  [${done}/${todo.length}] ${spec.key} ${width}x${height}`);
      writeFileSync(join(ASSETS_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  });
  await Promise.all(workers);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
