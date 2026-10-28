// Publishes the generated library to a Convex deployment through `templates/admin:publish` (the pipeline token path):
// design JSON, the photos it references (validated and stored server-side under templates/<slug>/) and thumbnails.
//
//   pnpm --filter @desyn/templates seed --target prod            # Convex Cloud prod (public.env + .env.keys)
//   pnpm --filter @desyn/templates seed --target dev             # Convex Cloud dev
//   pnpm --filter @desyn/templates seed --url <convex url>       # any deployment; token from TEMPLATES_PIPELINE_SECRET
//   options: --only <slug-prefix>  --slugs a,b,c  --jobs 4  --dry-run
//
// The token is read from the environment (TEMPLATES_PIPELINE_SECRET) or, for --target, from the repo's .env.keys
// (TEMPLATES_PIPELINE_SECRET_PROD / _DEV, created by deploy/scripts/convex-cloud-env.py). It is never printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Design } from "@desyn/schema";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  DESIGNS_DIR,
  IMAGES_DIR,
  MANIFEST,
  PUBLIC_DIR,
  REPO,
  readImageManifest,
  THUMBS_DIR,
} from "../lib/paths";
import { hash32 } from "../lib/rand";
import type { ManifestEntry } from "./generate";

const publish = makeFunctionReference<"action">("templates/admin:publish");

function envFileValue(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = new RegExp(`^${name}=(.*)$`).exec(line.trim());
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function target(args: string[]): { url: string; token: string } {
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const t = at("--target");
  if (t === "prod" || t === "dev") {
    const pub = join(REPO, "deploy/env/public.env");
    const url =
      t === "prod"
        ? envFileValue(pub, "NEXT_PUBLIC_CONVEX_URL")
        : `https://${(envFileValue(pub, "CONVEX_DEV_DEPLOYMENT") ?? "").replace(/^dev:/, "")}.eu-west-1.convex.cloud`;
    const token =
      process.env.TEMPLATES_PIPELINE_SECRET ??
      envFileValue(join(REPO, ".env.keys"), `TEMPLATES_PIPELINE_SECRET_${t.toUpperCase()}`);
    if (!url) throw new Error(`no Convex URL for ${t}`);
    if (!token)
      throw new Error(
        `TEMPLATES_PIPELINE_SECRET_${t.toUpperCase()} is not in .env.keys (run deploy/scripts/convex-cloud-env.py ${t})`,
      );
    return { url, token };
  }
  const url = at("--url") ?? process.env.CONVEX_URL;
  const token = process.env.TEMPLATES_PIPELINE_SECRET;
  if (!url || !token)
    throw new Error(
      "pass --target prod|dev, or --url with TEMPLATES_PIPELINE_SECRET in the environment",
    );
  return { url, token };
}

const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
  const jobs = Number(args.includes("--jobs") ? args[args.indexOf("--jobs") + 1] : 4);
  const dry = args.includes("--dry-run");
  const slugs = args.includes("--slugs")
    ? new Set((args[args.indexOf("--slugs") + 1] ?? "").split(","))
    : null;
  const manifest = (JSON.parse(readFileSync(MANIFEST, "utf8")) as ManifestEntry[]).filter(
    (m) => (!only || m.slug.startsWith(only)) && (!slugs || slugs.has(m.slug)),
  );
  const images = readImageManifest();
  const { url, token } = dry ? { url: "", token: "" } : target(args);
  const client = dry ? undefined : new ConvexHttpClient(url);
  console.log(`${manifest.length} template(s) -> ${dry ? "(dry run)" : new URL(url).host}`);
  const failures: string[] = [];
  let done = 0;
  const queue = [...manifest];
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        try {
          const design = JSON.parse(
            readFileSync(join(DESIGNS_DIR, `${e.slug}.json`), "utf8"),
          ) as Design;
          const assets = Object.values(design.assets)
            .filter((a) => a.kind === "image" && a.name && images[a.name])
            .map((a) => {
              const img = images[a.name as string] as (typeof images)[string];
              return {
                refId: a.id,
                name: img.file,
                mime: img.mime,
                data: bytes(join(IMAGES_DIR, img.file)),
              };
            });
          const thumbs = [
            { path: join(THUMBS_DIR, `${e.slug}.webp`), max: 640 },
            { path: join(PUBLIC_DIR, `${e.slug}.webp`), max: 560 },
          ].map(({ path, max }) => {
            const k = max / Math.max(e.width, e.height);
            return {
              width: Math.round(e.width * k),
              height: Math.round(e.height * k),
              mime: "image/webp",
              data: bytes(path),
            };
          });
          const body = {
            slug: e.slug,
            title: e.title,
            description: e.description,
            kind: e.kind,
            category: e.category,
            categories: e.categories,
            tags: e.tags,
            premium: e.premium,
            status: "published" as const,
            // Stable pseudo-popularity so the gallery has a varied default order before real usage data exists.
            popularity: hash32(`popularity:${e.slug}`) % 1000,
            collections: e.collections,
            design: JSON.stringify(design),
            token,
            assets,
            thumbnails: thumbs,
          };
          if (!dry && client) {
            // Templates that share a collection can collide on its document; Convex retries a few times, then
            // reports the conflict. Back off and try again.
            for (let attempt = 1; ; attempt++) {
              try {
                await client.action(publish, body);
                break;
              } catch (err) {
                const conflict =
                  err instanceof Error &&
                  /changed while this mutation was being run|Server Error/.test(err.message);
                if (!conflict || attempt >= 5) throw err;
                await new Promise((r) =>
                  setTimeout(r, 400 * attempt + Math.floor(Math.random() * 400)),
                );
              }
            }
          }
          done++;
          if (done % 20 === 0 || done === manifest.length)
            console.log(`  ${done}/${manifest.length}`);
        } catch (err) {
          failures.push(
            `${e.slug}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
          );
        }
      }
    }),
  );
  if (failures.length) {
    console.error(`${failures.length} failed:\n${failures.slice(0, 20).join("\n")}`);
    process.exit(1);
  }
  console.log(`published ${done}/${manifest.length}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
