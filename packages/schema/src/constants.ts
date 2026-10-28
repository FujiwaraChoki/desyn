import type {
  AnimationPreset,
  AssetKind,
  BlendMode,
  BooleanOp,
  Cap,
  ChartType,
  DesignKind,
  DropReason,
  EffectType,
  FillType,
  IssueCode,
  NodeType,
  OpKind,
  TransactionSource,
  Unit,
} from "./types";

/** Generated ids: 12 chars of [a-z0-9]. */
export const ID_PATTERN = /^[a-z0-9]{12}$/;
/** Document colors: lowercase "#rrggbb" or "#rrggbbaa". */
export const COLOR_PATTERN = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;

/** Reserved id of the root node. */
export const ROOT_ID = "root";
/** Current `Design.schema` version. */
export const SCHEMA_VERSION = 1;

export const UNITS = ["px", "mm", "in", "pt"] as const satisfies readonly Unit[];

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const satisfies readonly BlendMode[];

export const DESIGN_KINDS = [
  "social-post",
  "story",
  "poster",
  "flyer",
  "thumbnail",
  "banner",
  "ad",
  "presentation",
  "infographic",
  "business-card",
  "resume",
  "invitation",
  "menu",
  "logo",
  "newsletter",
  "document",
  "whiteboard",
  "website",
  "video",
  "book-cover",
  "certificate",
  "sticker",
  "mockup",
  "custom",
] as const satisfies readonly DesignKind[];

export const NODE_TYPES = [
  "root",
  "page",
  "frame",
  "group",
  "boolean",
  "rect",
  "ellipse",
  "polygon",
  "star",
  "line",
  "path",
  "text",
  "image",
  "svg",
  "video",
  "audio",
  "chart",
  "table",
  "qr",
] as const satisfies readonly NodeType[];

/** Node types that carry `children`. */
export const CONTAINER_TYPES = [
  "root",
  "page",
  "frame",
  "group",
  "boolean",
] as const satisfies readonly NodeType[];

/** Node types that carry `fills`, `strokes` and `cornerRadius`. */
export const SHAPED_TYPES = [
  "frame",
  "boolean",
  "rect",
  "ellipse",
  "polygon",
  "star",
  "path",
] as const satisfies readonly NodeType[];

export const FILL_TYPES = [
  "solid",
  "linear",
  "radial",
  "conic",
  "image",
] as const satisfies readonly FillType[];

export const EFFECT_TYPES = [
  "dropShadow",
  "innerShadow",
  "layerBlur",
  "backgroundBlur",
  "noise",
  "glow",
] as const satisfies readonly EffectType[];

export const ASSET_KINDS = [
  "image",
  "svg",
  "font",
  "video",
  "audio",
  "lottie",
  "data",
] as const satisfies readonly AssetKind[];

export const BOOLEAN_OPS = [
  "union",
  "subtract",
  "intersect",
  "exclude",
] as const satisfies readonly BooleanOp[];

export const CAPS = [
  "none",
  "arrow",
  "triangle",
  "circle",
  "square",
  "diamond",
  "bar",
] as const satisfies readonly Cap[];

export const CHART_TYPES = [
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "donut",
  "scatter",
  "radar",
  "funnel",
  "stacked-column",
  "progress",
] as const satisfies readonly ChartType[];

export const ANIMATION_PRESETS = [
  "fade",
  "rise",
  "drop",
  "slide-left",
  "slide-right",
  "zoom-in",
  "zoom-out",
  "pop",
  "rotate",
  "wipe",
  "typewriter",
  "pulse",
  "float",
  "shake",
  "blur-in",
  "none",
] as const satisfies readonly AnimationPreset[];

export const OP_KINDS = [
  "create",
  "update",
  "patch",
  "delete",
  "move",
  "asset",
  "styles",
  "doc",
] as const satisfies readonly OpKind[];

export const TRANSACTION_SOURCES = [
  "user",
  "ai",
  "workflow",
  "import",
  "template",
  "system",
] as const satisfies readonly TransactionSource[];

export const ISSUE_CODES = [
  "low-contrast",
  "tiny-text",
  "text-overflow",
  "off-page",
  "overlap",
  "misaligned",
  "uneven-spacing",
  "orphan-line",
  "too-many-fonts",
  "too-many-colors",
  "weak-hierarchy",
  "image-low-res",
  "unsafe-margin",
  "missing-alt",
  "unlabeled-group",
] as const satisfies readonly IssueCode[];

/** Fixed vocabulary of `dropped[].reason`, documented in spec/fixtures/README.md. */
export const DROP_REASONS = [
  "invalid-op",
  "missing-node",
  "missing-parent",
  "not-container",
  "cycle",
  "duplicate-id",
  "immutable-field",
  "invalid-node",
  "root-protected",
  "page-nesting",
  "invalid-path",
  "invalid-value",
] as const satisfies readonly DropReason[];

/** Node keys that `update` / `patch` may never touch (structure is changed with create/delete/move). */
export const IMMUTABLE_NODE_KEYS = ["id", "type", "parent", "children"] as const;

const containerSet: ReadonlySet<string> = new Set(CONTAINER_TYPES);
const shapedSet: ReadonlySet<string> = new Set(SHAPED_TYPES);
const nodeTypeSet: ReadonlySet<string> = new Set(NODE_TYPES);

export function isContainerType(type: string): type is (typeof CONTAINER_TYPES)[number] {
  return containerSet.has(type);
}
export function isShapedType(type: string): type is (typeof SHAPED_TYPES)[number] {
  return shapedSet.has(type);
}
export function isNodeType(type: string): type is NodeType {
  return nodeTypeSet.has(type);
}
