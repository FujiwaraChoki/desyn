"use client";

import type { ConvexReactClient } from "convex/react";
import { api, type Id } from "./convex-api";

export interface UploadedAsset {
  assetId: Id<"assets">;
  refId: string;
  deduplicated: boolean;
}

export interface UploadOptions {
  workspaceId: Id<"workspaces">;
  file: File;
  source?: "upload" | "brand";
  font?: { family: string; weight?: number; style?: "normal" | "italic" };
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** Lowercase hex SHA-256 of a file (lets the server deduplicate before any bytes move). */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Browsers report some types inconsistently (fonts especially); map by extension when empty. */
export function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  return (ext && byExt[ext]) ?? "application/octet-stream";
}

function put(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  // XHR rather than fetch: upload progress events.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      // content-length is set by the browser from the body and may not be set by scripts.
      if (name.toLowerCase() !== "content-length") xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status}). Try again.`));
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/**
 * Uploads a file to the workspace's asset library: request a presigned PUT (validated by plan and
 * type), send the bytes straight to storage, then let the server verify and register them.
 */
export async function uploadAsset(
  convex: ConvexReactClient,
  options: UploadOptions,
): Promise<UploadedAsset> {
  const { file, workspaceId } = options;
  const mime = mimeFor(file);
  const sha256 = await sha256Hex(file);
  const request = await convex.mutation(api.assets.assets.requestUpload, {
    workspaceId,
    name: file.name.slice(0, 200),
    mime,
    bytes: file.size,
    sha256,
    source: options.source ?? "upload",
    ...(options.font
      ? {
          family: options.font.family,
          weight: options.font.weight ?? 400,
          style: options.font.style ?? "normal",
        }
      : {}),
  });
  if (!request.upload) {
    options.onProgress?.(1);
    return { assetId: request.assetId, refId: request.refId, deduplicated: true };
  }
  await put(request.upload.url, file, request.upload.headers, options.onProgress, options.signal);
  const finalized = await convex.action(api.assets.assets.finalize, { assetId: request.assetId });
  return {
    assetId: finalized.assetId,
    refId: finalized.refId,
    deduplicated: finalized.deduplicated,
  };
}
