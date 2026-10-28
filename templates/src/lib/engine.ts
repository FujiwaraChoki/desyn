// The real Desyn engine (wasm, the same module the editor runs) used offline: it lays text out with the actual
// Google Fonts, recomputes every derived box (text auto-resize, auto-layout stacks, group bounds) and lints each page.
// Stored template designs are the engine's normalized output, so every client opens them with identical geometry.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type EngineModule, loadEngineModule } from "@desyn/engine";
import type { Design, Issue } from "@desyn/schema";
import { FONTS_DIR, REPO } from "./paths";

type WasmEngine = ReturnType<EngineModule["create"]>;

let modPromise: Promise<EngineModule> | undefined;

async function engineModule(): Promise<EngineModule> {
  modPromise ??= loadEngineModule(
    readFileSync(join(REPO, "packages/engine/wasm/desyn_engine_bg.wasm")),
  );
  return modPromise;
}

/** Font files on disk, grouped by family directory. */
function fontFiles(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const dir of readdirSync(FONTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const files = readdirSync(join(FONTS_DIR, dir.name))
      .filter((f) => f.endsWith(".ttf") || f.endsWith(".otf"))
      .map((f) => join(FONTS_DIR, dir.name, f));
    out.set(dir.name, files);
  }
  return out;
}

export interface NormalizeResult {
  design: Design;
  issues: { page: number; issue: Issue }[];
  missingFonts: string[];
}

/** One engine with every downloaded font registered; reused across designs. */
export class Normalizer {
  private constructor(private readonly engine: WasmEngine) {}

  static async create(): Promise<Normalizer> {
    const mod = await engineModule();
    const engine = mod.create(new Uint8Array(32).fill(7));
    for (const files of fontFiles().values()) {
      for (const file of files) engine.setFont(new Uint8Array(readFileSync(file)), null);
    }
    return new Normalizer(engine);
  }

  normalize(design: Design): NormalizeResult {
    this.engine.load(JSON.stringify(design));
    // Twice: auto-layout stacks size from text that the first pass measures.
    this.engine.relayout();
    this.engine.relayout();
    const out = JSON.parse(this.engine.snapshot()) as Design;
    const pages = (out.nodes.root as unknown as { children: string[] }).children;
    const issues: NormalizeResult["issues"] = [];
    pages.forEach((pageId, page) => {
      const found = JSON.parse(this.engine.lint(JSON.stringify({ pageId }))) as Issue[];
      for (const issue of found) issues.push({ page, issue });
    });
    const requests = JSON.parse(this.engine.takeRequests()) as { fonts?: { family: string }[] };
    const missingFonts = [...new Set((requests.fonts ?? []).map((f) => f.family))];
    return { design: out, issues, missingFonts };
  }
}
