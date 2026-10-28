// WasmHost: the AI agent's DocHost (packages/ai/src/host.ts) on top of the browser engine, so agent runs in the
// browser (BYOK / local models) read, render, measure and edit the same document the editor shows. Every edit
// is one engine transaction (one undo step); `onApply` lets the editor commit it to the server.
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
} from "@desyn/ai";
import type { ApplyResult, AssetRef, Description, Design, Id, Transaction } from "@desyn/schema";
import type { EngineClient } from "./client";

export interface WasmHostOptions {
  /** Upload new asset bytes (the editor stores them, e.g. S3 via Convex) and return the AssetRef. */
  upload: (bytes: Uint8Array, mime: string, meta?: AssetUploadMeta) => Promise<AssetRef>;
  /** Bytes of an existing asset (default: the engine's loaded bytes, resolving the asset when needed). */
  read?: (assetId: Id) => Promise<AssetBytes>;
  /** Current selection (editor state). */
  selection?: () => Id[];
  /** Page the user is looking at. */
  page?: () => Id | undefined;
  brand?: BrandKit;
  /** Run layout normalization on applied transactions (default true). */
  normalize?: boolean;
  /** Called after each applied transaction (commit `result.applied` to the server, push the undo entry). */
  onApply?: (tx: Transaction, result: ApplyResult) => void | Promise<void>;
}

const DEFAULT_PREVIEW_SIZE = 1024;

/** Pixel size from a PNG's IHDR chunk (the exporter may round or clamp the requested scale). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export class WasmHost implements DocHost {
  readonly assets: HostAssets;
  readonly brand?: BrandKit;
  /**
   * Uploaded bytes not yet referenced by the design. The engine decodes bytes by the asset's kind (image, SVG,
   * font), which it only knows once a transaction adds the AssetRef, so registration waits for that `apply`.
   */
  private readonly uploads = new Map<Id, AssetBytes>();

  constructor(
    private readonly client: EngineClient,
    private readonly options: WasmHostOptions,
  ) {
    this.brand = options.brand;
    this.assets = {
      upload: async (bytes, mime, meta) => {
        const ref = await options.upload(bytes, mime, meta);
        if (this.client.hasDesign && this.client.design.assets[ref.id]) {
          await this.client.setAsset(ref.id, bytes);
        } else {
          this.uploads.set(ref.id, { bytes, mime });
        }
        return ref;
      },
      read: async (id) => {
        const pending = this.uploads.get(id);
        if (pending) return { bytes: pending.bytes.slice(), mime: pending.mime };
        return options.read ? options.read(id) : this.client.readAsset(id);
      },
    };
  }

  get selection(): Id[] {
    return this.options.selection?.() ?? [];
  }

  get page(): Id | undefined {
    return this.options.page?.() ?? this.client.renderOptions.pageId ?? this.client.pages[0]?.id;
  }

  getDesign(): Design {
    return this.client.design;
  }

  describe(options: DescribeOptions = {}): Promise<Description> {
    const selection = options.selection ?? this.selection;
    return this.client.describe({
      pageId: options.pageId ?? this.pageFor(selection),
      selection,
      maxDepth: options.maxDepth,
      includeStyles: options.includeStyles,
    });
  }

  private pageFor(selection: Id[]): Id | undefined {
    const design = this.client.design;
    // The page of the first selected node, else the page in view.
    for (const id of selection) {
      let n = design.nodes[id];
      let guard = 0;
      while (n && n.type !== "page" && n.parent && guard++ < 512) n = design.nodes[n.parent];
      if (n?.type === "page") return n.id;
    }
    return this.page;
  }

  async render(options: RenderOptions = {}): Promise<RenderResult> {
    const pageId = options.pageId ?? this.page;
    const page = this.client.pages.find((p) => p.id === pageId) ?? this.client.pages[0];
    if (!page) throw new Error("the design has no pages");
    const region = options.region ?? { x: 0, y: 0, w: page.width, h: page.height };
    const longest = Math.max(region.w, region.h, 1);
    const scale = options.scale ?? Math.min(4, (options.maxSize ?? DEFAULT_PREVIEW_SIZE) / longest);
    // Previews for models must show real images and fonts.
    await this.client.ensureAssets();
    await this.client.flush(4000);
    const out = await this.client.export({
      format: "png",
      pageId: page.id,
      scale,
      region: options.region,
      background: options.background === undefined ? "page" : options.background,
    });
    const size = pngSize(out.bytes) ?? {
      width: Math.max(1, Math.round(region.w * scale)),
      height: Math.max(1, Math.round(region.h * scale)),
    };
    return { bytes: out.bytes, mime: "image/png", ...size };
  }

  async measure(items: MeasureItem[]): Promise<MeasureResult[]> {
    const sizes = await this.client.measure(
      items.map((it) => ({
        text: it.text as unknown as { text: string; style?: Record<string, unknown> }[],
        style: it.style as unknown as Record<string, unknown>,
        paragraph: it.paragraph as unknown as Record<string, unknown>,
        width: it.width,
      })),
    );
    return sizes.map((s) => ({ w: s.w, h: s.h, lines: s.lines }));
  }

  async apply(tx: Transaction): Promise<ApplyResult> {
    const result = await this.client.apply(tx, { normalize: this.options.normalize ?? true });
    await this.registerUploads();
    await this.options.onApply?.(tx, result);
    return result;
  }

  /**
   * Hands uploaded bytes to the engine once the design references them (no refetch of what was just uploaded).
   * Undecodable bytes reach the editor as the client's `assetError` event; the transaction itself stands.
   */
  private async registerUploads(): Promise<void> {
    const assets = this.client.design.assets;
    const ready = [...this.uploads].filter(([id]) => assets[id]);
    await Promise.all(
      ready.map(async ([id, file]) => {
        this.uploads.delete(id);
        await this.client.setAsset(id, file.bytes).catch(() => undefined);
      }),
    );
  }
}
