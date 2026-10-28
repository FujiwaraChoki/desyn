// zod v4 schemas for every type in ./types.ts. Objects are "loose": unknown keys are accepted and preserved
// (forward compatibility, DOCUMENT_MODEL §5). JSON Schema is generated from these (scripts/gen-json-schema.ts).
import { z } from "zod";
import {
  ANIMATION_PRESETS,
  ASSET_KINDS,
  BLEND_MODES,
  BOOLEAN_OPS,
  CAPS,
  CHART_TYPES,
  COLOR_PATTERN,
  DESIGN_KINDS,
  ID_PATTERN,
  ISSUE_CODES,
  ROOT_ID,
  TRANSACTION_SOURCES,
  UNITS,
} from "./constants";
import type { NodeType } from "./types";

const obj = z.looseObject;

/**
 * `z.record` that also validates an own `"__proto__"` entry. zod skips that key entirely (it is neither checked
 * nor copied into the parsed output, so a refinement cannot see it either), so a plain record would accept
 * `{"__proto__": <anything>}` that the Rust core and the JSON Schema reject. Documents are JSON, where
 * `"__proto__"` is an ordinary key; the check therefore runs on the raw input before the record schema.
 */
function record<K extends z.core.$ZodRecordKey, V extends z.ZodType>(key: K, value: V) {
  const checkProtoEntry = z.unknown().superRefine((input, ctx) => {
    if (typeof input !== "object" || input === null || !Object.hasOwn(input, "__proto__")) return;
    const entry: unknown = Object.getOwnPropertyDescriptor(input, "__proto__")?.value;
    if (!z.safeParse(key, "__proto__").success) {
      ctx.addIssue({ code: "custom", message: 'invalid key "__proto__"', path: ["__proto__"] });
    } else if (!value.safeParse(entry).success) {
      ctx.addIssue({
        code: "custom",
        message: 'invalid value at "__proto__"',
        path: ["__proto__"],
      });
    }
  });
  return checkProtoEntry.pipe(z.record(key, value));
}

// Primitives ----------------------------------------------------------------------------------------------------

export const IdSchema = z.string().regex(ID_PATTERN, "id must be 12 chars [a-z0-9]");
/** A node id: a regular Id or the reserved "root". */
export const NodeIdSchema = z.union([IdSchema, z.literal(ROOT_ID)]);
export const ColorSchema = z
  .string()
  .regex(COLOR_PATTERN, "color must be #rrggbb or #rrggbbaa (lowercase)");
export const ColorRefSchema = z.union([obj({ $var: z.string() }), obj({ $style: IdSchema })]);
export const ColorOrRefSchema = z.union([ColorSchema, ColorRefSchema]);
export const UnitSchema = z.enum(UNITS);
export const BlendModeSchema = z.enum(BLEND_MODES);
export const DesignKindSchema = z.enum(DESIGN_KINDS);
export const PathSegmentSchema = z.union([z.string(), z.int()]);

const unit01 = z.number().min(0).max(1);
const nonNeg = z.number().min(0);

// Paint ---------------------------------------------------------------------------------------------------------

export const StopSchema = obj({ pos: unit01, color: ColorOrRefSchema });

export const ImageAdjustSchema = obj({
  brightness: z.number(),
  contrast: z.number(),
  saturation: z.number(),
  hue: z.number(),
  temperature: z.number(),
  tint: z.number(),
  exposure: z.number(),
  vignette: z.number(),
  blur: z.number(),
  grayscale: z.number(),
  sepia: z.number(),
  sharpen: z.number(),
  grain: z.number(),
  duotone: z.tuple([ColorSchema, ColorSchema]).optional(),
  filter: z.string().optional(),
});

const fillCommon = {
  opacity: unit01.optional(),
  visible: z.boolean().optional(),
  blend: BlendModeSchema.optional(),
};

export const SolidFillSchema = obj({
  type: z.literal("solid"),
  color: ColorOrRefSchema,
  ...fillCommon,
});
export const LinearFillSchema = obj({
  type: z.literal("linear"),
  angle: z.number(),
  stops: z.array(StopSchema),
  ...fillCommon,
});
export const RadialFillSchema = obj({
  type: z.literal("radial"),
  cx: z.number(),
  cy: z.number(),
  rx: z.number(),
  ry: z.number(),
  stops: z.array(StopSchema),
  ...fillCommon,
});
export const ConicFillSchema = obj({
  type: z.literal("conic"),
  cx: z.number(),
  cy: z.number(),
  angle: z.number(),
  stops: z.array(StopSchema),
  ...fillCommon,
});
export const ImageFillSchema = obj({
  type: z.literal("image"),
  assetId: IdSchema,
  mode: z.enum(["fill", "fit", "tile", "stretch"]),
  scale: z.number().optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  rotation: z.number().optional(),
  adjust: ImageAdjustSchema.partial().optional(),
  ...fillCommon,
});
export const FillSchema = z.discriminatedUnion("type", [
  SolidFillSchema,
  LinearFillSchema,
  RadialFillSchema,
  ConicFillSchema,
  ImageFillSchema,
]);

export const StrokeSchema = obj({
  fills: z.array(FillSchema),
  width: nonNeg,
  align: z.enum(["inside", "center", "outside"]),
  dash: z.array(nonNeg).optional(),
  cap: z.enum(["butt", "round", "square"]),
  join: z.enum(["miter", "round", "bevel"]),
  miterLimit: z.number().optional(),
  visible: z.boolean().optional(),
});

const shadow = {
  x: z.number(),
  y: z.number(),
  blur: nonNeg,
  spread: z.number(),
  color: ColorSchema,
  visible: z.boolean().optional(),
};
export const DropShadowEffectSchema = obj({ type: z.literal("dropShadow"), ...shadow });
export const InnerShadowEffectSchema = obj({ type: z.literal("innerShadow"), ...shadow });
export const LayerBlurEffectSchema = obj({
  type: z.literal("layerBlur"),
  radius: nonNeg,
  visible: z.boolean().optional(),
});
export const BackgroundBlurEffectSchema = obj({
  type: z.literal("backgroundBlur"),
  radius: nonNeg,
  visible: z.boolean().optional(),
});
export const NoiseEffectSchema = obj({
  type: z.literal("noise"),
  amount: z.number(),
  scale: z.number(),
  mono: z.boolean(),
  visible: z.boolean().optional(),
});
export const GlowEffectSchema = obj({
  type: z.literal("glow"),
  radius: nonNeg,
  strength: z.number(),
  color: ColorSchema,
  visible: z.boolean().optional(),
});
export const EffectSchema = z.discriminatedUnion("type", [
  DropShadowEffectSchema,
  InnerShadowEffectSchema,
  LayerBlurEffectSchema,
  BackgroundBlurEffectSchema,
  NoiseEffectSchema,
  GlowEffectSchema,
]);

export const AnimationSchema = obj({
  id: IdSchema,
  preset: z.enum(ANIMATION_PRESETS),
  phase: z.enum(["in", "out", "loop"]),
  startMs: z.number(),
  durationMs: nonNeg,
  easing: z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out", "spring"]),
});

// Text ----------------------------------------------------------------------------------------------------------

export const TextStyleSchema = obj({
  fontFamily: z.string(),
  fontWeight: z.number(),
  fontStyle: z.enum(["normal", "italic"]),
  fontSize: nonNeg,
  fills: z.array(FillSchema),
  letterSpacing: z.number(),
  textCase: z.enum(["none", "upper", "lower", "title"]),
  decoration: z.enum(["none", "underline", "strikethrough"]),
  link: z.string().optional(),
  highlight: ColorSchema.optional(),
  features: z.array(z.string()).optional(),
  variations: record(z.string(), z.number()).optional(),
});
export const PartialTextStyleSchema = TextStyleSchema.partial();

export const ParagraphStyleSchema = obj({
  align: z.enum(["left", "center", "right", "justify"]),
  direction: z.enum(["ltr", "rtl", "auto"]),
  lineHeight: obj({ unit: z.enum(["auto", "px", "percent"]), value: z.number() }),
  spacing: z.number(),
  indent: z.number(),
  list: z.enum(["none", "bullet", "number"]),
});
export const PartialParagraphStyleSchema = ParagraphStyleSchema.partial();

export const TextRunSchema = obj({ text: z.string(), style: PartialTextStyleSchema.optional() });

// Nodes ---------------------------------------------------------------------------------------------------------

export const RoleSchema = z.string();
export const CornerRadiusSchema = z.union([nonNeg, z.tuple([nonNeg, nonNeg, nonNeg, nonNeg])]);

export const AutoLayoutSchema = obj({
  mode: z.enum(["row", "column", "grid"]),
  gap: z.number(),
  rowGap: z.number().optional(),
  padding: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  mainAlign: z.enum(["start", "center", "end", "space-between"]),
  crossAlign: z.enum(["start", "center", "end", "stretch", "baseline"]),
  wrap: z.boolean().optional(),
  columns: z.int().min(1).optional(),
  reverse: z.boolean().optional(),
});

const baseShape = {
  id: NodeIdSchema,
  name: z.string(),
  parent: NodeIdSchema.nullable(),
  x: z.number(),
  y: z.number(),
  width: nonNeg,
  height: nonNeg,
  rotation: z.number(),
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  opacity: unit01,
  blend: BlendModeSchema,
  visible: z.boolean(),
  locked: z.boolean(),
  effects: z.array(EffectSchema),
  role: RoleSchema.optional(),
  constraints: obj({
    h: z.enum(["left", "right", "center", "stretch", "scale"]),
    v: z.enum(["top", "bottom", "center", "stretch", "scale"]),
  }).optional(),
  sizing: obj({
    h: z.enum(["fixed", "hug", "fill"]),
    v: z.enum(["fixed", "hug", "fill"]),
  }).optional(),
  aspectLocked: z.boolean().optional(),
  mask: z.boolean().optional(),
  link: z.string().optional(),
  alt: z.string().optional(),
  anim: z.array(AnimationSchema).optional(),
  notes: z.string().optional(),
  meta: record(z.string(), z.unknown()).optional(),
};

/** Non-root nodes always have an Id (never "root") and a parent. */
const childShape = { ...baseShape, id: IdSchema, parent: NodeIdSchema };

const containerShape = {
  children: z.array(IdSchema),
  clip: z.boolean(),
  layout: AutoLayoutSchema.optional(),
};

const shapedShape = {
  fills: z.array(FillSchema),
  strokes: z.array(StrokeSchema),
  cornerRadius: CornerRadiusSchema,
  cornerSmoothing: unit01.optional(),
};

export const RootNodeSchema = obj({
  ...baseShape,
  id: z.literal(ROOT_ID),
  parent: z.null(),
  type: z.literal("root"),
  children: z.array(IdSchema),
});

export const PageNodeSchema = obj({
  ...childShape,
  parent: z.literal(ROOT_ID),
  ...containerShape,
  type: z.literal("page"),
  unit: UnitSchema,
  background: z.array(FillSchema),
  bleed: nonNeg,
  durationMs: nonNeg.optional(),
  transition: obj({
    kind: z.enum(["none", "fade", "slide", "push", "zoom", "dissolve"]),
    durationMs: nonNeg,
  }).optional(),
  grid: obj({
    columns: z.int().min(1),
    gutter: z.number(),
    margin: z.number(),
    baseline: z.number().optional(),
  }).optional(),
  guides: z.array(obj({ axis: z.enum(["x", "y"]), pos: z.number() })).optional(),
});

export const FrameNodeSchema = obj({
  ...childShape,
  ...containerShape,
  ...shapedShape,
  type: z.literal("frame"),
});
export const GroupNodeSchema = obj({ ...childShape, ...containerShape, type: z.literal("group") });
export const BooleanNodeSchema = obj({
  ...childShape,
  ...containerShape,
  ...shapedShape,
  type: z.literal("boolean"),
  op: z.enum(BOOLEAN_OPS),
});
export const RectNodeSchema = obj({ ...childShape, ...shapedShape, type: z.literal("rect") });
export const EllipseNodeSchema = obj({
  ...childShape,
  ...shapedShape,
  type: z.literal("ellipse"),
  arc: obj({ start: z.number(), end: z.number(), inner: unit01 }).optional(),
});
export const PolygonNodeSchema = obj({
  ...childShape,
  ...shapedShape,
  type: z.literal("polygon"),
  sides: z.int().min(3),
});
export const StarNodeSchema = obj({
  ...childShape,
  ...shapedShape,
  type: z.literal("star"),
  points: z.int().min(3),
  innerRatio: unit01,
});
export const CapSchema = z.enum(CAPS);
export const LineNodeSchema = obj({
  ...childShape,
  type: z.literal("line"),
  strokes: z.array(StrokeSchema),
  startCap: CapSchema,
  endCap: CapSchema,
});
export const PathNodeSchema = obj({
  ...childShape,
  ...shapedShape,
  type: z.literal("path"),
  paths: z.array(obj({ d: z.string(), fillRule: z.enum(["nonzero", "evenodd"]) })),
});
export const TextNodeSchema = obj({
  ...childShape,
  type: z.literal("text"),
  runs: z.array(TextRunSchema),
  style: TextStyleSchema,
  paragraph: ParagraphStyleSchema,
  autoResize: z.enum(["none", "height", "width"]),
  maxLines: z.int().min(1).optional(),
  curve: z.number().optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]),
  strokes: z.array(StrokeSchema).optional(),
  styleRef: IdSchema.optional(),
});
export const ImageNodeSchema = obj({
  ...childShape,
  type: z.literal("image"),
  assetId: IdSchema,
  fit: z.enum(["fill", "fit", "crop", "tile"]),
  crop: obj({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    zoom: z.number().optional(),
  }).optional(),
  cornerRadius: CornerRadiusSchema,
  shape: z.union([z.enum(["rect", "ellipse"]), obj({ path: z.string() })]).optional(),
  adjust: ImageAdjustSchema.optional(),
  strokes: z.array(StrokeSchema),
  maskAssetId: IdSchema.optional(),
});
export const SvgNodeSchema = obj({
  ...childShape,
  type: z.literal("svg"),
  assetId: IdSchema.optional(),
  markup: z.string().optional(),
  recolor: record(ColorSchema, ColorSchema).optional(),
  strokes: z.array(StrokeSchema).optional(),
}).refine((n) => n.assetId !== undefined || n.markup !== undefined, {
  message: "svg node requires assetId or markup",
});
export const VideoNodeSchema = obj({
  ...childShape,
  type: z.literal("video"),
  assetId: IdSchema,
  trimStartMs: nonNeg,
  trimEndMs: nonNeg.optional(),
  muted: z.boolean(),
  loop: z.boolean(),
  volume: z.number(),
  posterAssetId: IdSchema.optional(),
  fit: z.enum(["fill", "fit", "crop"]),
  cornerRadius: nonNeg,
});
export const AudioNodeSchema = obj({
  ...childShape,
  type: z.literal("audio"),
  assetId: IdSchema,
  startMs: z.number(),
  trimStartMs: nonNeg,
  trimEndMs: nonNeg.optional(),
  volume: z.number(),
  fadeInMs: nonNeg.optional(),
  fadeOutMs: nonNeg.optional(),
});
export const ChartNodeSchema = obj({
  ...childShape,
  type: z.literal("chart"),
  chart: z.enum(CHART_TYPES),
  data: obj({
    labels: z.array(z.string()),
    series: z.array(
      obj({ name: z.string(), values: z.array(z.number()), color: ColorSchema.optional() }),
    ),
  }),
  options: obj({
    legend: z.boolean(),
    grid: z.boolean(),
    labels: z.boolean(),
    palette: z.array(ColorSchema),
    fontFamily: z.string(),
    fontSize: nonNeg,
    textColor: ColorSchema,
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().optional(),
  }),
});
export const TableCellSchema = obj({
  r: z.int().min(0),
  c: z.int().min(0),
  text: z.string(),
  style: PartialTextStyleSchema.optional(),
  fill: FillSchema.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  colspan: z.int().min(1).optional(),
  rowspan: z.int().min(1).optional(),
});
export const TableNodeSchema = obj({
  ...childShape,
  type: z.literal("table"),
  rows: z.int().min(0),
  cols: z.int().min(0),
  colWidths: z.array(nonNeg),
  rowHeights: z.array(nonNeg),
  cells: z.array(TableCellSchema),
  header: z.boolean(),
  stripe: z.boolean(),
  borderColor: ColorSchema,
  borderWidth: nonNeg,
  cellPadding: nonNeg,
  defaultStyle: TextStyleSchema,
});
export const QrNodeSchema = obj({
  ...childShape,
  type: z.literal("qr"),
  data: z.string(),
  fg: ColorSchema,
  bg: ColorSchema,
  errorCorrection: z.enum(["L", "M", "Q", "H"]),
  rounded: z.boolean(),
});

/** Per-type node schemas, keyed by `type`. */
export const NODE_SCHEMAS = {
  root: RootNodeSchema,
  page: PageNodeSchema,
  frame: FrameNodeSchema,
  group: GroupNodeSchema,
  boolean: BooleanNodeSchema,
  rect: RectNodeSchema,
  ellipse: EllipseNodeSchema,
  polygon: PolygonNodeSchema,
  star: StarNodeSchema,
  line: LineNodeSchema,
  path: PathNodeSchema,
  text: TextNodeSchema,
  image: ImageNodeSchema,
  svg: SvgNodeSchema,
  video: VideoNodeSchema,
  audio: AudioNodeSchema,
  chart: ChartNodeSchema,
  table: TableNodeSchema,
  qr: QrNodeSchema,
} as const satisfies Record<NodeType, z.ZodType>;

/**
 * Any node. A plain union keyed on `type` (svg carries a refinement, which discriminated unions do not accept);
 * use `nodeSchemaFor(type)` for precise per-type error messages.
 */
export const NodeSchema = z.union([
  RootNodeSchema,
  PageNodeSchema,
  FrameNodeSchema,
  GroupNodeSchema,
  BooleanNodeSchema,
  RectNodeSchema,
  EllipseNodeSchema,
  PolygonNodeSchema,
  StarNodeSchema,
  LineNodeSchema,
  PathNodeSchema,
  TextNodeSchema,
  ImageNodeSchema,
  SvgNodeSchema,
  VideoNodeSchema,
  AudioNodeSchema,
  ChartNodeSchema,
  TableNodeSchema,
  QrNodeSchema,
]);

export function nodeSchemaFor(type: unknown): z.ZodType | undefined {
  return typeof type === "string" && Object.hasOwn(NODE_SCHEMAS, type)
    ? NODE_SCHEMAS[type as NodeType]
    : undefined;
}

// Design --------------------------------------------------------------------------------------------------------

export const AssetRefSchema = obj({
  id: IdSchema,
  kind: z.enum(ASSET_KINDS),
  url: z.string().optional(),
  storageKey: z.string().optional(),
  mime: z.string(),
  bytes: nonNeg.optional(),
  width: nonNeg.optional(),
  height: nonNeg.optional(),
  durationMs: nonNeg.optional(),
  hash: z.string().optional(),
  name: z.string().optional(),
  source: z.enum(["upload", "ai", "stock", "template", "brand"]).optional(),
  attribution: obj({
    author: z.string().optional(),
    license: z.string().optional(),
    url: z.string().optional(),
  }).optional(),
  ai: obj({
    provider: z.string(),
    model: z.string(),
    prompt: z.string(),
    seed: z.number().optional(),
  }).optional(),
  family: z.string().optional(),
  weight: z.number().optional(),
  style: z.enum(["normal", "italic"]).optional(),
});

export const ColorStyleSchema = obj({ name: z.string(), value: ColorSchema });
export const TextStyleDefSchema = obj({
  name: z.string(),
  style: TextStyleSchema,
  paragraph: PartialParagraphStyleSchema.optional(),
});
export const EffectStyleSchema = obj({ name: z.string(), effects: z.array(EffectSchema) });

export const DesignStylesSchema = obj({
  colors: record(IdSchema, ColorStyleSchema),
  text: record(IdSchema, TextStyleDefSchema),
  effects: record(IdSchema, EffectStyleSchema),
  variables: record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const DesignMetaSchema = obj({
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  templateId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  locale: z.string().optional(),
});

export const DesignSchema = obj({
  schema: z.literal(1),
  id: IdSchema,
  name: z.string(),
  kind: DesignKindSchema,
  nodes: record(NodeIdSchema, NodeSchema),
  assets: record(IdSchema, AssetRefSchema),
  styles: DesignStylesSchema,
  brandKitId: z.string().optional(),
  meta: DesignMetaSchema,
});

// Operations ----------------------------------------------------------------------------------------------------

const pathSchema = z.array(PathSegmentSchema);

export const CreateOpSchema = obj({
  op: z.literal("create"),
  nodes: z.array(NodeSchema).min(1),
  parent: NodeIdSchema,
  index: z.int().optional(),
});
export const UpdateOpSchema = obj({
  op: z.literal("update"),
  id: NodeIdSchema,
  set: record(z.string(), z.unknown()).optional(),
  unset: z.array(z.string()).optional(),
});
export const PatchOpSchema = obj({
  op: z.literal("patch"),
  id: NodeIdSchema,
  path: pathSchema,
  value: z.unknown(),
});
export const DeleteOpSchema = obj({ op: z.literal("delete"), id: NodeIdSchema });
export const MoveOpSchema = obj({
  op: z.literal("move"),
  id: NodeIdSchema,
  parent: NodeIdSchema,
  index: z.int().optional(),
});
export const AssetOpSchema = obj({
  op: z.literal("asset"),
  set: record(IdSchema, AssetRefSchema).optional(),
  remove: z.array(IdSchema).optional(),
});
export const StylesOpSchema = obj({
  op: z.literal("styles"),
  path: pathSchema,
  value: z.unknown(),
});
export const DocOpSchema = obj({
  op: z.literal("doc"),
  set: obj({
    name: z.string().optional(),
    kind: DesignKindSchema.optional(),
    brandKitId: z.string().optional(),
    meta: record(z.string(), z.unknown()).optional(),
  }),
  unset: z.array(z.literal("brandKitId")).optional(),
});
export const OpSchema = z.discriminatedUnion("op", [
  CreateOpSchema,
  UpdateOpSchema,
  PatchOpSchema,
  DeleteOpSchema,
  MoveOpSchema,
  AssetOpSchema,
  StylesOpSchema,
  DocOpSchema,
]);

export const TransactionSourceSchema = z.enum(TRANSACTION_SOURCES);
export const TransactionSchema = obj({
  id: IdSchema,
  label: z.string(),
  ops: z.array(OpSchema),
  source: TransactionSourceSchema,
  actor: obj({
    userId: z.string().optional(),
    runId: z.string().optional(),
    agent: z.string().optional(),
  }).optional(),
  ts: z.number(),
});

// Describe ------------------------------------------------------------------------------------------------------

export const IssueCodeSchema = z.enum(ISSUE_CODES);
export const IssueSchema = obj({
  severity: z.enum(["info", "warn", "error"]),
  code: IssueCodeSchema,
  ids: z.array(NodeIdSchema),
  message: z.string(),
  fix: z.array(OpSchema).optional(),
});

export interface DNodeShape {
  id: string;
  type: string;
  name: string;
  role?: string | undefined;
  box: { x: number; y: number; w: number; h: number; rotation: number };
  z: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  text?: string | undefined;
  font?:
    | {
        family: string;
        size: number;
        weight: number;
        color: string;
        align: string;
        lines?: number | undefined;
      }
    | undefined;
  fill?: string | undefined;
  image?:
    | {
        assetId: string;
        alt?: string | undefined;
        kind?: "photo" | "illustration" | "logo" | "icon" | "unknown" | undefined;
      }
    | undefined;
  semantic?: string | undefined;
  children?: DNodeShape[] | undefined;
  flags?: string[] | undefined;
}

export const DNodeSchema: z.ZodType<DNodeShape> = obj({
  id: NodeIdSchema,
  type: z.string(),
  name: z.string(),
  role: z.string().optional(),
  box: obj({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), rotation: z.number() }),
  z: z.number(),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: z.number(),
  text: z.string().optional(),
  font: obj({
    family: z.string(),
    size: z.number(),
    weight: z.number(),
    color: ColorSchema,
    align: z.string(),
    lines: z.number().optional(),
  }).optional(),
  fill: z.string().optional(),
  image: obj({
    assetId: IdSchema,
    alt: z.string().optional(),
    kind: z.enum(["photo", "illustration", "logo", "icon", "unknown"]).optional(),
  }).optional(),
  semantic: z.string().optional(),
  get children() {
    return z.array(DNodeSchema).optional();
  },
  flags: z.array(z.string()).optional(),
});

export const DescriptionSchema = obj({
  design: obj({
    id: IdSchema,
    name: z.string(),
    kind: DesignKindSchema,
    pageCount: z.int().min(0),
    locale: z.string().optional(),
  }),
  page: obj({
    id: IdSchema,
    index: z.int().min(0),
    width: z.number(),
    height: z.number(),
    unit: UnitSchema,
    background: z.string(),
  }),
  selection: z.array(NodeIdSchema),
  tree: z.array(DNodeSchema),
  palette: z.array(obj({ color: ColorSchema, share: z.number() })),
  fonts: z.array(obj({ family: z.string(), weights: z.array(z.number()), usedBy: z.number() })),
  typography: obj({
    scale: z.array(z.number()),
    headlineSize: z.number().optional(),
    bodySize: z.number().optional(),
    ratio: z.number().optional(),
  }),
  grid: obj({
    margins: obj({ t: z.number(), r: z.number(), b: z.number(), l: z.number() }),
    alignments: z.array(
      obj({ axis: z.enum(["x", "y"]), pos: z.number(), ids: z.array(NodeIdSchema) }),
    ),
    spacingRhythm: z.number().optional(),
  }),
  hierarchy: z.array(obj({ id: NodeIdSchema, rank: z.number(), reason: z.string() })),
  issues: z.array(IssueSchema),
});
