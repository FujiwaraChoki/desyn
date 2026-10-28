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
import { type EngineClient, WasmHost } from "@desyn/engine";
import type { ApplyResult, AssetRef, Description, Design, Id, Transaction } from "@desyn/schema";
import type { EditorController } from "../../controller.ts";

/**
 * The agent's DocHost for browser runs. Reads (describe, render, measure) use the engine through
 * @desyn/engine's WasmHost so the agent sees exactly what the canvas shows; every edit goes through
 * `editor.apply` instead of straight into the engine, so it is normalized, committed through the sync client
 * (live for collaborators) and recorded in history under the run's id (one undo step per run).
 * Before the engine is up (or where it cannot run) the @desyn/ai TypeScript approximations stand in.
 */

/** TS fallbacks of @desyn/ai, loaded with the rest of the agent code. */
export interface HostFallbacks {
  describeDesign(design: Design, options: DescribeOptions): Description;
  renderDesign(design: Design, options: RenderOptions): RenderResult;
  measureText(item: MeasureItem): MeasureResult;
}

export interface EditorHostOptions {
  runId: string;
  userId: string | null;
  /** Selection the run was started with (edit-selection mode); `[]` = the whole design. */
  selection: Id[];
  brand?: BrandKit;
  fallbacks: HostFallbacks;
  /** Called after every applied transaction (the session highlights the touched layers). */
  onApplied?: (tx: Transaction, result: ApplyResult) => void;
}

function kindForMime(mime: string): AssetRef["kind"] {
  if (mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("font/")) return "font";
  return "data";
}

export class EditorDocHost implements DocHost {
  readonly assets: HostAssets;
  readonly brand?: BrandKit;
  private wasm: { client: EngineClient; host: WasmHost } | null = null;

  constructor(
    private readonly editor: EditorController,
    private readonly options: EditorHostOptions,
  ) {
    if (options.brand) this.brand = options.brand;
    this.assets = {
      upload: (bytes, mime, meta) => this.upload(bytes, mime, meta),
      read: (id) => this.read(id),
    };
  }

  /** WasmHost over the live engine client (recreated when the canvas remounted). */
  private engineHost(): WasmHost | null {
    const client = this.editor.engineClient;
    if (!client?.hasDesign) return null;
    if (this.wasm?.client !== client) {
      const host = new WasmHost(client, {
        // Uploads go through `this.upload`; WasmHost is used for reads only.
        upload: (bytes, mime, meta) => this.upload(bytes, mime, meta),
        selection: () => this.selection,
        page: () => this.page,
        normalize: true,
      });
      this.wasm = { client, host };
    }
    return this.wasm.host;
  }

  get selection(): Id[] {
    const design = this.editor.design;
    return this.options.selection.filter((id) => !!design?.nodes[id]);
  }

  get page(): Id | undefined {
    return this.editor.getState().pageId ?? undefined;
  }

  getDesign(): Design {
    const design = this.editor.design;
    if (!design) throw new Error("The design is not loaded.");
    return design;
  }

  async describe(options: DescribeOptions = {}): Promise<Description> {
    const wasm = this.engineHost();
    if (wasm) return wasm.describe(options);
    const pageId = options.pageId ?? this.page;
    return this.options.fallbacks.describeDesign(this.getDesign(), {
      ...options,
      ...(pageId ? { pageId } : {}),
      selection: options.selection ?? this.selection,
    });
  }

  async render(options: RenderOptions = {}): Promise<RenderResult> {
    const wasm = this.engineHost();
    if (wasm) return wasm.render(options);
    const pageId = options.pageId ?? this.page;
    return this.options.fallbacks.renderDesign(this.getDesign(), {
      ...options,
      ...(pageId ? { pageId } : {}),
    });
  }

  async measure(items: MeasureItem[]): Promise<MeasureResult[]> {
    const wasm = this.engineHost();
    if (wasm) return wasm.measure(items);
    return items.map((item) => this.options.fallbacks.measureText(item));
  }

  async apply(tx: Transaction): Promise<ApplyResult> {
    const actor = {
      ...(this.options.userId ? { userId: this.options.userId } : {}),
      runId: this.options.runId,
      agent: "desyn",
    };
    const result = await this.editor.apply(
      { ...tx, source: "ai", actor },
      { label: tx.label, normalize: true },
    );
    if (!result) {
      throw new Error(
        this.editor.canEdit
          ? "The edit could not be applied."
          : "This design is view only, so the AI cannot change it.",
      );
    }
    this.options.onApplied?.(tx, result);
    return result;
  }

  private async upload(
    bytes: Uint8Array,
    mime: string,
    meta: AssetUploadMeta = {},
  ): Promise<AssetRef> {
    const type = mime || "application/octet-stream";
    const name =
      meta.name ?? `ai-${this.options.runId}.${type.split("/")[1]?.split("+")[0] ?? "bin"}`;
    const blob = new Blob([bytes as BlobPart], { type });
    const uploaded = await this.editor.assets.upload(new File([blob], name, { type }), name);
    const ref: AssetRef = {
      ...uploaded.ref,
      kind: meta.kind ?? uploaded.ref.kind ?? kindForMime(type),
    };
    if (meta.width && !ref.width) ref.width = Math.round(meta.width);
    if (meta.height && !ref.height) ref.height = Math.round(meta.height);
    if (meta.ai) {
      ref.ai = meta.ai;
      ref.source = "ai";
    } else if (meta.source) {
      ref.source = meta.source;
    }
    if (meta.attribution) ref.attribution = meta.attribution;
    return ref;
  }

  private async read(id: Id): Promise<AssetBytes> {
    const client = this.editor.engineClient;
    if (client?.hasDesign) {
      try {
        return await client.readAsset(id);
      } catch {
        // Not decoded in the engine yet: fetch it below.
      }
    }
    const ref = this.editor.design?.assets[id];
    if (!ref) throw new Error(`The asset "${id}" is not part of this design.`);
    const url = await this.editor.assets.urlFor(ref);
    if (!url) throw new Error("The image is not available yet. Try again in a moment.");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read the image (${res.status}).`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get("content-type")?.split(";")[0]?.trim() || ref.mime,
    };
  }
}
