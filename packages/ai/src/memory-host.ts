// In-memory DocHost on @desyn/doc-ops: applies transactions with the reference applier, describes and renders
// with the approximate TypeScript implementations, keeps uploaded assets in a map. Used by tests, offline evals
// and tools such as the template previewer; also a reference for WasmHost / WorkerHost authors.

import { applyTransaction, getNode, pages } from "@desyn/doc-ops";
import {
  type ApplyResult,
  type AssetRef,
  type Design,
  type Id,
  newId,
  type Transaction,
} from "@desyn/schema";
import { describeDesign } from "./design/describe";
import { measureText } from "./design/measure";
import { renderDesign } from "./design/render";
import type {
  AssetBytes,
  AssetUploadMeta,
  BrandKit,
  DescribeOptions,
  DocHost,
  HostAssets,
  MeasureItem,
  MeasureResult,
  RenderOptions,
  RenderResult,
} from "./host";
import { imageSize, sha256Hex, sniffMime } from "./util/bytes";

export interface MemoryHostOptions {
  selection?: Id[];
  page?: Id;
  brand?: BrandKit;
  /** Pre-seeded asset bytes keyed by asset id. */
  assetBytes?: Record<Id, AssetBytes>;
}

function kindForMime(mime: string): AssetRef["kind"] {
  if (mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("font/") || mime.includes("font")) return "font";
  return "data";
}

class MemoryAssets implements HostAssets {
  readonly bytes = new Map<Id, AssetBytes>();
  readonly uploaded: AssetRef[] = [];

  async upload(bytes: Uint8Array, mime: string, meta: AssetUploadMeta = {}): Promise<AssetRef> {
    const id = newId();
    const resolvedMime = mime || sniffMime(bytes) || "application/octet-stream";
    const size = imageSize(bytes, resolvedMime);
    const ref: AssetRef = {
      id,
      kind: meta.kind ?? kindForMime(resolvedMime),
      mime: resolvedMime,
      bytes: bytes.byteLength,
      hash: await sha256Hex(bytes),
      storageKey: `memory/${id}`,
    };
    const width = meta.width ?? size?.width;
    const height = meta.height ?? size?.height;
    if (width) ref.width = Math.round(width);
    if (height) ref.height = Math.round(height);
    if (meta.name) ref.name = meta.name;
    if (meta.source) ref.source = meta.source;
    if (meta.attribution) ref.attribution = meta.attribution;
    if (meta.ai) ref.ai = meta.ai;
    if (meta.durationMs) ref.durationMs = meta.durationMs;
    this.bytes.set(id, { bytes, mime: resolvedMime });
    this.uploaded.push(ref);
    return ref;
  }

  async read(assetId: Id): Promise<AssetBytes> {
    const found = this.bytes.get(assetId);
    if (!found) throw new Error(`asset "${assetId}" is not available in this host`);
    return found;
  }
}

export class MemoryHost implements DocHost {
  private design: Design;
  private currentSelection: Id[];
  private currentPage: Id | undefined;
  readonly assets: MemoryAssets;
  readonly brand: BrandKit | undefined;
  /** Every transaction applied, with its result (tests assert on these). */
  readonly history: { tx: Transaction; result: ApplyResult }[] = [];

  constructor(design: Design, options: MemoryHostOptions = {}) {
    this.design = design;
    this.currentSelection = options.selection ?? [];
    this.currentPage = options.page;
    this.brand = options.brand;
    this.assets = new MemoryAssets();
    for (const [id, bytes] of Object.entries(options.assetBytes ?? {}))
      this.assets.bytes.set(id, bytes);
  }

  get selection(): Id[] {
    return this.currentSelection.filter((id) => getNode(this.design, id));
  }

  get page(): Id | undefined {
    if (this.currentPage && getNode(this.design, this.currentPage)?.type === "page")
      return this.currentPage;
    return pages(this.design)[0]?.id;
  }

  select(ids: Id[]): void {
    this.currentSelection = [...ids];
  }

  setPage(pageId: Id): void {
    this.currentPage = pageId;
  }

  getDesign(): Design {
    return this.design;
  }

  async describe(options: DescribeOptions = {}): Promise<ReturnType<typeof describeDesign>> {
    const pageId = options.pageId ?? this.page;
    return describeDesign(this.design, {
      ...options,
      ...(pageId ? { pageId } : {}),
      selection: options.selection ?? this.selection,
    });
  }

  async render(options: RenderOptions = {}): Promise<RenderResult> {
    const pageId = options.pageId ?? this.page;
    return renderDesign(this.design, { ...options, ...(pageId ? { pageId } : {}) });
  }

  async measure(items: MeasureItem[]): Promise<MeasureResult[]> {
    return items.map((item) => {
      const { w, h, lines } = measureText(item);
      return { w, h, lines };
    });
  }

  async apply(tx: Transaction): Promise<ApplyResult> {
    const result = applyTransaction(this.design, tx);
    this.design = result.design;
    this.history.push({ tx, result });
    return result;
  }
}
