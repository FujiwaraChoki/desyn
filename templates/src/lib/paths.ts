import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageAsset } from "./doc";

export const ROOT = join(import.meta.dirname, "../..");
export const REPO = join(ROOT, "..");
export const ASSETS_DIR = join(ROOT, "assets");
export const IMAGES_DIR = join(ASSETS_DIR, "images");
export const DESIGNS_DIR = join(ROOT, "designs");
export const THUMBS_DIR = join(ROOT, "thumbnails");
export const PUBLIC_DIR = join(ROOT, "public");
export const FONTS_DIR = join(ROOT, ".fonts");
export const RENDERS_DIR = join(ROOT, ".renders");
export const MANIFEST = join(ROOT, "manifest.json");

export type ImageManifest = Record<string, Omit<ImageAsset, "key">>;

export function readImageManifest(): ImageManifest {
  const path = join(ASSETS_DIR, "manifest.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ImageManifest) : {};
}
