// Loads the wasm-bindgen modules. The interactive module (`desyn_engine`) is imported statically so bundlers
// (Next / Turbopack, Vite) emit it with the worker; the exporters module (`desyn_export`: PDF / PPTX / GIF) is
// imported dynamically on the first such export.
import initEngine, { Engine, engineInfo } from "../wasm/desyn_engine.js";
import type { EngineInfo } from "./protocol";

/** The methods of the wasm `Engine` class (both modules expose the same class). */
export type WasmEngine = Engine;

export interface EngineModule {
  /** Creates an engine instance. */
  create(seed: Uint8Array): WasmEngine;
  /** The module's linear memory (frame buffer views are taken from `memory.buffer`). */
  memory: WebAssembly.Memory;
  info: EngineInfo;
}

type Input = string | URL | Response | BufferSource | WebAssembly.Module;

/** Default location of the interactive module, resolved by the bundler next to this file. */
export function defaultEngineWasmUrl(): string {
  return new URL("../wasm/desyn_engine_bg.wasm", import.meta.url).href;
}

/** Default location of the exporters module. */
export function defaultExportWasmUrl(): string {
  return new URL("../wasm/desyn_export_bg.wasm", import.meta.url).href;
}

/**
 * URLs of the bundled fonts, one literal `new URL()` per file so bundlers (Turbopack, Vite, webpack) emit each
 * file as a static asset; they are fetched only when a design needs the family.
 */
export function defaultFontUrls(): Record<string, string> {
  return {
    "Inter-VF.ttf": new URL("../fonts/Inter-VF.ttf", import.meta.url).href,
    "Inter-Italic-VF.ttf": new URL("../fonts/Inter-Italic-VF.ttf", import.meta.url).href,
    "InstrumentSans-VF.ttf": new URL("../fonts/InstrumentSans-VF.ttf", import.meta.url).href,
    "InstrumentSans-Italic-VF.ttf": new URL(
      "../fonts/InstrumentSans-Italic-VF.ttf",
      import.meta.url,
    ).href,
    "InstrumentSerif-Regular.ttf": new URL("../fonts/InstrumentSerif-Regular.ttf", import.meta.url)
      .href,
    "InstrumentSerif-Italic.ttf": new URL("../fonts/InstrumentSerif-Italic.ttf", import.meta.url)
      .href,
    "JetBrainsMono-VF.ttf": new URL("../fonts/JetBrainsMono-VF.ttf", import.meta.url).href,
    "JetBrainsMono-Italic-VF.ttf": new URL("../fonts/JetBrainsMono-Italic-VF.ttf", import.meta.url)
      .href,
    "NotoSansArabic-VF.ttf": new URL("../fonts/NotoSansArabic-VF.ttf", import.meta.url).href,
    "NotoSansHebrew-VF.ttf": new URL("../fonts/NotoSansHebrew-VF.ttf", import.meta.url).href,
    "NotoEmoji-VF.ttf": new URL("../fonts/NotoEmoji-VF.ttf", import.meta.url).href,
  };
}

let engineModule: Promise<EngineModule> | null = null;
let exportModule: Promise<EngineModule> | null = null;

/** Instantiates the interactive module once per realm (worker or window). */
export function loadEngineModule(input: Input = defaultEngineWasmUrl()): Promise<EngineModule> {
  if (!engineModule) {
    engineModule = (async () => {
      const out = await initEngine({ module_or_path: input });
      return {
        create: (seed: Uint8Array) => new Engine(seed),
        memory: out.memory,
        info: JSON.parse(engineInfo()) as EngineInfo,
      };
    })();
    engineModule.catch(() => {
      engineModule = null;
    });
  }
  return engineModule;
}

/** Instantiates the exporters module (PDF / PPTX / GIF) once per realm, on demand. */
export function loadExportModule(input: Input = defaultExportWasmUrl()): Promise<EngineModule> {
  if (!exportModule) {
    exportModule = (async () => {
      const glue = await import("../wasm/desyn_export.js");
      const out = await glue.default({ module_or_path: input });
      return {
        create: (seed: Uint8Array) => new glue.Engine(seed) as unknown as WasmEngine,
        memory: out.memory,
        info: JSON.parse(glue.engineInfo()) as EngineInfo,
      };
    })();
    exportModule.catch(() => {
      exportModule = null;
    });
  }
  return exportModule;
}
