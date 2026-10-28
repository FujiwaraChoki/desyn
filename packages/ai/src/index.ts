// @desyn/ai — providers, model routing, media, the design agent and its tools, workflows, prompts.
export * from "./agent/events";
export {
  type DesignPlan,
  DesignPlanSchema,
  type GenerateDesignOptions,
  type GenerateDesignResult,
  type GeneratedAsset,
  generateDesign,
} from "./agent/generate";
export {
  type AgentBudget,
  compactMessages,
  type RunAgentOptions,
  type RunAgentResult,
  runAgent,
} from "./agent/run";
export {
  type AgentModel,
  routeAgentModel,
  routeText,
  routeTextModels,
  setupMedia,
} from "./agent/setup";
export * from "./byok";
export * from "./credits";
export { type ApplyBrandOptions, type BrandReport, brandOps } from "./design/brand";
export { coverCrop } from "./design/crop";
export { backdropColorOf, describeDesign } from "./design/describe";
export {
  collectTexts,
  type RelayoutReport,
  relayoutTranslations,
  type TextItem,
  translateTexts,
} from "./design/localize";
export { fitFontSize, lineHeightPx, lineWidth, measureText, wrapLines } from "./design/measure";
export { describeFills, fillColor, resolveColor, textOf } from "./design/paint";
export { decodePng, encodePng } from "./design/raster";
export { type ReflowOptions, type ReflowResult, reflowPage } from "./design/reflow";
export { renderDesign } from "./design/render";
export * from "./errors";
export * from "./host";
export { FAL_ADAPTERS, falAdapterFor, nearestRatio, parseFalOutput } from "./media/fal-endpoints";
export { createMedia, outpaintExpansion } from "./media/media";
export * from "./media/moderation";
export {
  constrainPalette,
  extractSvg,
  optimizeSvg,
  parseSvg,
  SvgParseError,
  sanitizeSvg,
  serializeSvg,
  svgColors,
  validateSvg,
} from "./media/svg";
export { type TraceResult, traceRaster } from "./media/trace";
export * from "./media/types";
export { MemoryHost, type MemoryHostOptions } from "./memory-host";
export * from "./models";
export { BRAND_RULES, brandSummary } from "./prompts/brand";
export { critiqueSystemPrompt } from "./prompts/critique";
export {
  ACCESSIBILITY,
  ALL_PRINCIPLES,
  COLOR,
  IMAGERY,
  LAYOUT,
  SPACING,
  TYPOGRAPHY,
} from "./prompts/design";
export { fontPairingText } from "./prompts/fonts";
export {
  escapeUntrusted,
  guardName,
  guardStrings,
  UNTRUSTED_POLICY,
  wrapUntrusted,
} from "./prompts/guard";
export { KIND_GUIDES, type KindGuide, kindGuideText } from "./prompts/kinds";
export {
  COPYWRITING,
  copySystemPrompt,
  expansionFactor,
  isRtlLocale,
  LOCALIZATION,
  scriptFonts,
  translateSystemPrompt,
} from "./prompts/language";
export { svgSystemPrompt } from "./prompts/svg";
export { buildSystemPrompt, type SystemPromptContext } from "./prompts/system";
export * from "./providers";
export { createIconify, DEFAULT_ICON_SETS } from "./search/icons";
export { combineStock, createPexels, createUnsplash, stockFromEnv } from "./search/stock";
export {
  createDesignTools,
  describeDesignTools,
  READ_ONLY_TOOLS,
  TOOL_NAMES,
  type ToolDescriptor,
  type ToolName,
  toolsForMode,
} from "./tools";
export { type CompactDiff, commit, diffFor } from "./tools/commit";
export * from "./tools/types";
export * from "./workflows";
