import type { AssetRef, Id } from "@desyn/schema";
import type { AssetBackend, AssetView } from "./convex-transport.ts";

/**
 * Asset URLs and uploads for the open design.
 *
 * `AssetRef.url` is never persisted (DOCUMENT_MODEL §2): signed GET URLs come from `assets.designUrls` and are
 * cached until they expire (the server signs them per hour, valid for two). Uploads follow the presigned flow
 * of the assets functions: request -> PUT straight to storage -> finalize (server verifies and sanitizes).
 */
export interface UploadedAsset {
  /** Ready to insert with an `asset` op (`ref.id` is what nodes reference). */
  ref: AssetRef;
  /** Signed URL for immediate display (null when storage gives none yet). */
  url: string | null;
  deduplicated: boolean;
  /** Library asset id (`assets` document): rename / delete / folders. */
  assetId: string;
}

export interface UploadOptions {
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** Early refresh margin so a URL handed to the engine does not expire mid-fetch. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** Browsers report some types inconsistently (fonts, pasted files); fall back to the extension. */
export function mimeOf(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export async function sha256OfBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** AssetRef for an asset document (the shape `designs.commit` expects in an `asset` op). */
export function assetRefFromView(view: AssetView): AssetRef {
  const ref: AssetRef = { id: view.refId, kind: view.kind, mime: view.mime };
  if (view.storageKey) ref.storageKey = view.storageKey;
  if (view.bytes) ref.bytes = view.bytes;
  if (view.width !== null) ref.width = view.width;
  if (view.height !== null) ref.height = view.height;
  if (view.durationMs !== null) ref.durationMs = view.durationMs;
  if (view.hash) ref.hash = view.hash;
  if (view.name) ref.name = view.name;
  ref.source = view.source === "brand" ? "brand" : view.source === "ai" ? "ai" : "upload";
  if (view.kind === "font") {
    if (view.family) ref.family = view.family;
    if (view.weight !== null) ref.weight = view.weight;
    if (view.style) ref.style = view.style;
  }
  return ref;
}

function putWithProgress(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  options: UploadOptions,
): Promise<void> {
  // XHR rather than fetch: upload progress events.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      // content-length comes from the body; browsers refuse to let scripts set it.
      if (name.toLowerCase() !== "content-length") xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status}). Try again.`));
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

export class AssetService {
  private readonly urls = new Map<Id, string>();
  private expiresAt: number | null = null;
  private fetching: Promise<void> | null = null;
  private readonly misses = new Set<Id>();

  constructor(
    private readonly backend: AssetBackend,
    private readonly workspaceId: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  private expired(): boolean {
    return this.expiresAt !== null && this.now() > this.expiresAt - EXPIRY_MARGIN_MS;
  }

  /** Signed URLs for every asset of the design (one query), refreshed when they near expiry. */
  refresh(): Promise<void> {
    this.fetching ??= this.backend
      .designUrls()
      .then(({ urls, expiresAt }) => {
        this.urls.clear();
        for (const [id, url] of Object.entries(urls)) this.urls.set(id, url);
        this.expiresAt = expiresAt;
        this.misses.clear();
      })
      .finally(() => {
        this.fetching = null;
      });
    return this.fetching;
  }

  /** URL for an asset (engine `resolveAsset`): cached, fetched when unknown or expired. */
  async urlFor(asset: Pick<AssetRef, "id" | "url">): Promise<string | null> {
    if (this.expired()) await this.refresh();
    const cached = this.urls.get(asset.id);
    if (cached) return cached;
    if (asset.url) return asset.url;
    if (!this.misses.has(asset.id)) {
      // New asset (added by a collaborator or the AI since the last fetch): one refresh, then give up.
      this.misses.add(asset.id);
      await this.refresh();
    }
    return this.urls.get(asset.id) ?? null;
  }

  /** Remembers a URL learned elsewhere (fresh uploads). */
  prime(id: Id, url: string): void {
    this.urls.set(id, url);
  }

  /** Uploads a file to the design's workspace library and returns its AssetRef. */
  async upload(
    file: File | Blob,
    name?: string,
    options: UploadOptions = {},
  ): Promise<UploadedAsset> {
    const workspaceId = this.workspaceId();
    if (!workspaceId) throw new Error("This design is not in a workspace you can upload to.");
    const fileName = name ?? (file instanceof File ? file.name : "pasted");
    const mime = mimeOf({ name: fileName, type: file.type });
    const sha256 = await sha256OfBlob(file);
    const request = await this.backend.requestUpload({
      workspaceId,
      name: fileName.slice(0, 200) || "upload",
      mime,
      bytes: file.size,
      sha256,
    });
    let assetId = request.assetId;
    let deduplicated = request.deduplicated;
    if (request.upload) {
      await putWithProgress(request.upload.url, file, request.upload.headers, options);
      const finalized = await this.backend.finalize(request.assetId);
      assetId = finalized.assetId;
      deduplicated = finalized.deduplicated;
    } else {
      options.onProgress?.(1);
    }
    const view = await this.backend.getAsset(assetId);
    const ref = assetRefFromView(view);
    if (view.url) this.prime(ref.id, view.url);
    return { ref, url: view.url, deduplicated, assetId };
  }
}
