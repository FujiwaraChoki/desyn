import {
  type AssetBytes,
  type AssetUploadMeta,
  type BrandKit,
  type DescribeOptions,
  type DocHost,
  describeDesign,
  type HostAssets,
  type MeasureItem,
  type MeasureResult,
  measureText,
  type RenderOptions,
  type RenderResult,
  renderDesign,
} from "@desyn/ai";
import { applyOps, applyTransaction, getNode, pages } from "@desyn/doc-ops";
import type {
  ApplyResult,
  AssetRef,
  Description,
  Design,
  DroppedOp,
  Id,
  Op,
  Transaction,
} from "@desyn/schema";

// WorkerHost: the agent's DocHost inside Convex actions (SPEC §7). The design lives in memory, loaded from the
// designs owner's materialized state; every edit is committed through the same commit path as clients
// (`designs.commitAs`, actor = the run), so collaborators see it live and it lands in the undo log as one
// transaction. Describe / render / measure / layout go to the render worker (DOCUMENT_MODEL §8) when one is
// configured; without a worker the @desyn/ai TypeScript approximations keep the agent usable (self-host).
//
// The host is runtime-agnostic: Convex wiring is injected as a `HostBackend`, so unit tests use a fake one.

export interface HostCommitResult {
  seq: number;
  /** JSON of the ops the server applied. */
  applied: string;
  dropped: DroppedOp[];
  duplicate: boolean;
}

export interface HostWorker {
  /** POST to the render worker (JSON body); throws on transport errors and non-2xx answers. */
  call(path: string, body: unknown): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export interface HostBackend {
  /** Full current design and its seq. */
  load(): Promise<{ design: Design; seq: number }>;
  /** Accepted transactions after `seq` (oldest first, contiguous) or `gap` when the log was compacted. */
  opsAfter(seq: number): Promise<{ txs: { seq: number; tx: Transaction }[]; gap: boolean }>;
  commit(tx: Transaction): Promise<HostCommitResult>;
  /** Resolvable (signed) URLs of the design's assets by AssetRef id. */
  assetUrls(): Promise<Record<Id, string>>;
  /** Stores bytes as a workspace asset and returns its AssetRef (not yet referenced by the design). */
  ingest(bytes: Uint8Array, mime: string, meta: AssetUploadMeta): Promise<AssetRef>;
  /** Downloads asset bytes from a resolvable URL. */
  fetchBytes(url: string): Promise<AssetBytes>;
  /** Render worker, or null when none is configured. */
  worker: HostWorker | null;
}

export interface WorkerHostOptions {
  selection?: Id[];
  page?: Id;
  brand?: BrandKit;
  /** Normalize derived geometry (text boxes, auto-layout, groups) through the worker before committing. */
  normalize?: boolean;
  /** Called after every committed transaction (seq, server-applied op count). */
  onCommit?: (seq: number, applied: number) => void;
}

/** Fields the layout engine derives; the only ones normalization may change. */
const DERIVED: readonly ("x" | "y" | "width" | "height")[] = ["x", "y", "width", "height"];
const EPSILON = 0.01;
/** Signed asset URLs are valid for at least an hour; refresh well before that. */
const URL_TTL_MS = 20 * 60_000;

/** Updates that bring `local` to the worker's normalized geometry (nothing else is taken from the worker). */
export function derivedGeometryOps(local: Design, normalized: Design): Op[] {
  const ops: Op[] = [];
  for (const [id, node] of Object.entries(local.nodes)) {
    const target = normalized.nodes[id];
    if (!target || id === "root" || target.type !== node.type) continue;
    const set: Record<string, number> = {};
    for (const key of DERIVED) {
      const a = node[key];
      const b = target[key];
      if (typeof b === "number" && Number.isFinite(b) && Math.abs(a - b) > EPSILON) set[key] = b;
    }
    if (Object.keys(set).length > 0) ops.push({ op: "update", id, set });
  }
  return ops;
}

/** Width / height of a PNG, JPEG or WebP from its header. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[8] === 0x57) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      const w = 1 + (view.getUint16(24, true) | (view.getUint8(26) << 16));
      const h = 1 + (view.getUint16(27, true) | (view.getUint8(29) << 16));
      return { width: w, height: h };
    }
    if (chunk === "VP8 ")
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (chunk === "VP8L") {
      const [b0, b1, b2, b3] = [21, 22, 23, 24].map((o) => view.getUint8(o)) as [
        number,
        number,
        number,
        number,
      ];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = view.getUint8(i + 1);
      const len = view.getUint16(i + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

class WorkerHostAssets implements HostAssets {
  constructor(private readonly host: WorkerHost) {}

  upload(bytes: Uint8Array, mime: string, meta: AssetUploadMeta = {}): Promise<AssetRef> {
    return this.host.backend.ingest(bytes, mime, meta);
  }

  async read(assetId: Id): Promise<AssetBytes> {
    const urls = await this.host.assetUrls();
    const url = urls[assetId];
    if (!url) throw new Error(`asset "${assetId}" has no stored file`);
    return this.host.backend.fetchBytes(url);
  }
}

export class WorkerHost implements DocHost {
  private design: Design;
  private currentSeq: number;
  private currentSelection: Id[];
  private readonly requestedPage: Id | undefined;
  private urls: { at: number; map: Record<Id, string> } | null = null;
  readonly assets: HostAssets;
  readonly brand: BrandKit | undefined;

  private constructor(
    readonly backend: HostBackend,
    loaded: { design: Design; seq: number },
    private readonly options: WorkerHostOptions,
  ) {
    this.design = loaded.design;
    this.currentSeq = loaded.seq;
    this.currentSelection = options.selection ?? [];
    this.requestedPage = options.page;
    this.brand = options.brand;
    this.assets = new WorkerHostAssets(this);
  }

  static async open(backend: HostBackend, options: WorkerHostOptions = {}): Promise<WorkerHost> {
    return new WorkerHost(backend, await backend.load(), options);
  }

  get seq(): number {
    return this.currentSeq;
  }

  get selection(): Id[] {
    return this.currentSelection.filter((id) => getNode(this.design, id));
  }

  get page(): Id | undefined {
    if (this.requestedPage && getNode(this.design, this.requestedPage)?.type === "page")
      return this.requestedPage;
    return pages(this.design)[0]?.id;
  }

  getDesign(): Design {
    return this.design;
  }

  /** Catches up with transactions committed by others (collaborators, other runs) since the last read. */
  async sync(): Promise<void> {
    for (let guard = 0; guard < 1000; guard++) {
      const { txs, gap } = await this.backend.opsAfter(this.currentSeq);
      if (gap) {
        const loaded = await this.backend.load();
        this.design = loaded.design;
        this.currentSeq = loaded.seq;
        return;
      }
      if (txs.length === 0) return;
      let design = this.design;
      for (const { seq, tx } of txs) {
        design = applyOps(design, tx.ops, { validateNodes: false }).design;
        this.currentSeq = seq;
      }
      this.design = design;
    }
  }

  async assetUrls(): Promise<Record<Id, string>> {
    if (!this.urls || Date.now() - this.urls.at > URL_TTL_MS) {
      this.urls = { at: Date.now(), map: await this.backend.assetUrls() };
    }
    const missing = Object.keys(this.design.assets).some((id) => !this.urls?.map[id]);
    // Assets added during the run (generated images) need fresh URLs.
    if (missing) this.urls = { at: Date.now(), map: await this.backend.assetUrls() };
    return this.urls.map;
  }

  /** The design with resolvable asset URLs, as the worker needs it (never committed). */
  private async workerDesign(): Promise<{ design: Design; assetUrls: Record<Id, string> }> {
    const urls = await this.assetUrls();
    const assets: Design["assets"] = {};
    for (const [id, asset] of Object.entries(this.design.assets)) {
      const url = urls[id];
      assets[id] = url ? { ...asset, url } : asset;
    }
    return { design: { ...this.design, assets }, assetUrls: urls };
  }

  async describe(options: DescribeOptions = {}): Promise<Description> {
    await this.sync();
    const pageId = options.pageId ?? this.page;
    const selection = options.selection ?? this.selection;
    const worker = this.backend.worker;
    if (worker) {
      const { design, assetUrls } = await this.workerDesign();
      const out = await worker.call("/v1/describe", {
        design,
        ...(pageId ? { pageId } : {}),
        selection,
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
        ...(options.includeStyles !== undefined ? { includeStyles: options.includeStyles } : {}),
        assetUrls,
      });
      return JSON.parse(new TextDecoder().decode(out.bytes)) as Description;
    }
    return describeDesign(this.design, { ...options, ...(pageId ? { pageId } : {}), selection });
  }

  async render(options: RenderOptions = {}): Promise<RenderResult> {
    await this.sync();
    const pageId = options.pageId ?? this.page;
    const worker = this.backend.worker;
    if (!worker || !pageId) {
      return renderDesign(this.design, { ...options, ...(pageId ? { pageId } : {}) });
    }
    const page = getNode(this.design, pageId);
    const region = options.region ?? {
      x: 0,
      y: 0,
      w: page?.width ?? 1080,
      h: page?.height ?? 1080,
    };
    const maxSize = options.maxSize ?? 1024;
    const scale = Math.max(
      0.1,
      Math.min(8, options.scale ?? maxSize / Math.max(1, region.w, region.h)),
    );
    const { design, assetUrls } = await this.workerDesign();
    const out = await worker.call("/v1/render", {
      design,
      pageId,
      ...(options.region ? { region: options.region } : {}),
      scale,
      format: "png",
      ...(options.background ? { background: options.background } : {}),
      assetUrls,
    });
    const size = imageDimensions(out.bytes) ?? {
      width: Math.round(region.w * scale),
      height: Math.round(region.h * scale),
    };
    return { bytes: out.bytes, mime: "image/png", ...size };
  }

  async measure(items: MeasureItem[]): Promise<MeasureResult[]> {
    const worker = this.backend.worker;
    if (worker && items.length > 0) {
      const out = await worker.call("/v1/measure", { items });
      const parsed = JSON.parse(new TextDecoder().decode(out.bytes)) as {
        sizes: { w: number; h: number; lines: number }[];
      };
      return parsed.sizes.map((s) => ({ w: s.w, h: s.h, lines: s.lines }));
    }
    return items.map((item) => {
      const { w, h, lines } = measureText(item);
      return { w, h, lines };
    });
  }

  /** Ops that make derived geometry match the real layout engine (text boxes, auto-layout, groups). */
  private async normalizationOps(before: Design, tx: Transaction): Promise<Op[]> {
    const worker = this.backend.worker;
    if (!worker || this.options.normalize === false) return [];
    try {
      const local = applyTransaction(before, tx, { validateNodes: false }).design;
      const { design, assetUrls } = await this.workerDesign();
      const out = await worker.call("/v1/apply", { design, tx, assetUrls });
      const parsed = JSON.parse(new TextDecoder().decode(out.bytes)) as { design?: Design };
      return parsed.design ? derivedGeometryOps(local, parsed.design) : [];
    } catch {
      // Layout is a refinement: commit the edit as the model made it when the worker cannot help.
      return [];
    }
  }

  async apply(tx: Transaction): Promise<ApplyResult> {
    await this.sync();
    const before = this.design;
    const extra = await this.normalizationOps(before, tx);
    const committed: Transaction = extra.length > 0 ? { ...tx, ops: [...tx.ops, ...extra] } : tx;
    const res = await this.backend.commit(committed);
    const applied = JSON.parse(res.applied) as Op[];
    if (!res.duplicate && res.seq === this.currentSeq + 1) {
      this.design = applyOps(before, applied, { validateNodes: false }).design;
      this.currentSeq = res.seq;
    } else {
      await this.sync();
    }
    this.options.onCommit?.(res.seq, applied.length);
    const inverse = applyTransaction(
      before,
      { ...tx, ops: applied },
      { validateNodes: false },
    ).inverse;
    return {
      design: this.design,
      inverse,
      applied,
      // Normalization ops are an implementation detail: report drops of the model's own ops only.
      dropped: res.dropped.filter((d) => d.index < tx.ops.length),
    };
  }
}
