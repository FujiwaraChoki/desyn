// @desyn/engine: the Rust/wasm Desyn engine for the web.
export { AssetFetchError, AssetLoader, type AssetLoaderOptions } from "./assets";
export {
  type AssetResolver,
  type AssetSource,
  type ClientEvents,
  EngineClient,
  type EngineClientOptions,
} from "./client";
export {
  type CssFace,
  cssWeight,
  type DesignFontNeeds,
  designFontNeeds,
  type FontFile,
  FontLoader,
  type FontLoaderConfig,
  type FontLoadRequest,
  type FontSource,
  GOOGLE_FONTS_CSS2,
  normalizeFamily,
  parseFontCss,
  parseUnicodeRange,
} from "./fonts";
export { type Emit, ENGINE_WORKER_METHODS, EngineHost } from "./host";
export * from "./protocol";
export {
  createLocalChannel,
  createRpcClient,
  type Endpoint,
  exposeRpc,
  type Remote,
  RemoteError,
  type RpcClient,
  type RpcServer,
  transfer,
} from "./rpc";
export { type TextBridgeOptions, TextEditBridge, type TextGeometry } from "./text-bridge";
export {
  applyRunStyle,
  caretStyle,
  diffText,
  normalizeRuns,
  type RunStyle,
  rangeHasStyle,
  replaceText,
  runsText,
  styleAt,
  textTransaction,
} from "./text-ops";
export {
  applyAffine,
  clampZoom,
  deviceScale,
  fitRect,
  MAX_ZOOM,
  MIN_ZOOM,
  pageRectToScreen,
  pageToScreen,
  panBy,
  screenToPage,
  snapToDevice,
  wheelZoomFactor,
  zoomAt,
} from "./viewport";
export {
  defaultEngineWasmUrl,
  defaultExportWasmUrl,
  defaultFontUrls,
  type EngineModule,
  loadEngineModule,
  loadExportModule,
  type WasmEngine,
} from "./wasm";
export { WasmHost, type WasmHostOptions } from "./wasm-host";
