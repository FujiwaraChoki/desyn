// Shared zod pieces for tool inputs. Inputs are deliberately friendlier than the document model (hex shorthand,
// line-height multipliers, a single `fill`) and are converted to exact model values in ./build.ts.
import { BLEND_MODES, KNOWN_ROLES, normalizeHex } from "@desyn/schema";
import { z } from "zod";

export const IdInput = z
  .string()
  .min(1)
  .describe("element id (12 chars) as returned by read_design / query_elements");

export const ColorInput = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const hex = normalizeHex(v);
    if (!hex) {
      ctx.addIssue({ code: "custom", message: `"${v}" is not a hex color; use #rrggbb` });
      return z.NEVER;
    }
    return hex;
  })
  .describe("hex color, e.g. #1f2937 or #1f293780 (with alpha)");

const StopInput = z.object({ pos: z.number().min(0).max(1), color: ColorInput });

export const FillInput = z
  .union([
    ColorInput,
    z.literal("none"),
    z.object({
      type: z.literal("solid"),
      color: ColorInput,
      opacity: z.number().min(0).max(1).optional(),
    }),
    z.object({
      type: z.literal("linear"),
      angle: z.number().describe("degrees, 0 = left→right, 90 = top→bottom"),
      stops: z.array(StopInput).min(2),
      opacity: z.number().min(0).max(1).optional(),
    }),
    z.object({
      type: z.literal("radial"),
      stops: z.array(StopInput).min(2),
      cx: z.number().optional(),
      cy: z.number().optional(),
      r: z.number().optional().describe("radius as a fraction of the box (default 0.5)"),
      opacity: z.number().min(0).max(1).optional(),
    }),
    z.object({
      type: z.literal("image"),
      assetId: z.string(),
      mode: z.enum(["fill", "fit", "tile", "stretch"]).optional(),
      opacity: z.number().min(0).max(1).optional(),
    }),
  ])
  .describe('a hex color, "none", or a gradient/image fill object');

export const StrokeInput = z.object({
  color: ColorInput,
  width: z.number().min(0),
  align: z.enum(["inside", "center", "outside"]).optional(),
  dash: z.array(z.number().min(0)).optional(),
});

export const ShadowInput = z.object({
  x: z.number().default(0),
  y: z.number().default(8),
  blur: z.number().min(0).default(24),
  spread: z.number().default(0),
  color: ColorInput.default("#00000033"),
});

export const RunInput = z.object({
  text: z.string(),
  color: ColorInput.optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
});

export const LayoutInput = z.object({
  mode: z.enum(["row", "column", "grid"]),
  gap: z.number().min(0).default(16),
  rowGap: z.number().min(0).optional(),
  padding: z
    .union([z.number().min(0), z.array(z.number().min(0)).length(4)])
    .default(0)
    .describe("number or [top, right, bottom, left]"),
  mainAlign: z.enum(["start", "center", "end", "space-between"]).default("start"),
  crossAlign: z.enum(["start", "center", "end", "stretch", "baseline"]).default("start"),
  wrap: z.boolean().optional(),
  columns: z.number().int().min(1).optional(),
});

export const AnimInput = z.object({
  preset: z.enum([
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
  ]),
  phase: z.enum(["in", "out", "loop"]).default("in"),
  startMs: z.number().min(0).default(0),
  durationMs: z.number().min(0).default(600),
  easing: z
    .enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out", "spring"])
    .default("ease-out"),
});

const roleHint = `semantic role; known: ${KNOWN_ROLES.join(", ")}`;

/** Properties shared by create and update (all optional). */
export const StyleProps = {
  name: z
    .string()
    .max(80)
    .optional()
    .describe("meaningful layer name, e.g. 'Headline', 'CTA button'"),
  role: z.string().max(40).optional().describe(roleHint),
  x: z.number().optional().describe("px, relative to the parent's top-left"),
  y: z.number().optional(),
  width: z.number().min(0).optional(),
  height: z.number().min(0).optional(),
  rotation: z.number().optional().describe("degrees clockwise"),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  blend: z.enum(BLEND_MODES).optional(),
  fill: FillInput.optional().describe(
    "single fill (shapes, frames, text color via gradient, page background)",
  ),
  fills: z.array(FillInput).optional().describe("fill stack bottom→top (overrides fill)"),
  stroke: z.union([StrokeInput, z.literal("none")]).optional(),
  cornerRadius: z.union([z.number().min(0), z.array(z.number().min(0)).length(4)]).optional(),
  shadow: z.union([ShadowInput, z.literal("none")]).optional(),
  blur: z.number().min(0).optional().describe("layer blur radius px"),
  // text
  text: z.string().optional().describe('text content; "\\n" starts a new paragraph'),
  runs: z.array(RunInput).optional().describe("rich text runs (overrides text)"),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  italic: z.boolean().optional(),
  color: ColorInput.optional().describe("text color (text), stroke color (line), foreground (qr)"),
  align: z.enum(["left", "center", "right", "justify"]).optional(),
  lineHeight: z
    .number()
    .positive()
    .optional()
    .describe("multiplier, e.g. 1.1 for headlines, 1.5 for body"),
  letterSpacing: z.number().optional().describe("em, e.g. -0.02 or 0.12"),
  textCase: z.enum(["none", "upper", "lower", "title"]).optional(),
  underline: z.boolean().optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  autoResize: z
    .enum(["none", "height", "width"])
    .optional()
    .describe("height: fixed width, grows down (default); width: single line; none: fixed box"),
  maxLines: z.number().int().min(1).optional(),
  direction: z.enum(["ltr", "rtl", "auto"]).optional(),
  // images / svg
  assetId: z.string().optional(),
  fit: z.enum(["fill", "fit", "crop", "tile"]).optional(),
  alt: z.string().max(300).optional(),
  imageShape: z.enum(["rect", "ellipse"]).optional(),
  markup: z.string().optional().describe("inline SVG markup (sanitized)"),
  // containers
  clip: z.boolean().optional(),
  layout: z
    .union([LayoutInput, z.literal("none")])
    .optional()
    .describe("auto-layout for frames"),
  // lines
  startCap: z.enum(["none", "arrow", "triangle", "circle", "square", "diamond", "bar"]).optional(),
  endCap: z.enum(["none", "arrow", "triangle", "circle", "square", "diamond", "bar"]).optional(),
  // paths, polygons
  d: z
    .string()
    .optional()
    .describe("SVG path data in the element's local box (0..width, 0..height)"),
  sides: z.number().int().min(3).optional(),
  points: z.number().int().min(3).optional(),
  innerRatio: z.number().min(0.05).max(0.95).optional(),
  // qr
  qrData: z.string().optional(),
  background: ColorInput.optional().describe("QR background color"),
  // misc
  link: z.string().optional(),
  constraints: z
    .object({
      h: z.enum(["left", "right", "center", "stretch", "scale"]),
      v: z.enum(["top", "bottom", "center", "stretch", "scale"]),
    })
    .optional(),
  sizing: z
    .object({ h: z.enum(["fixed", "hug", "fill"]), v: z.enum(["fixed", "hug", "fill"]) })
    .optional(),
  anim: z.array(AnimInput).optional(),
  notes: z.string().optional(),
  slot: z.string().optional().describe("template slot name stored in meta.slot"),
};

export const ChartInput = z.object({
  type: z.enum([
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
  ]),
  labels: z.array(z.string()),
  series: z
    .array(
      z.object({ name: z.string(), values: z.array(z.number()), color: ColorInput.optional() }),
    )
    .min(1),
  legend: z.boolean().optional(),
  grid: z.boolean().optional(),
  unit: z.string().optional(),
  palette: z.array(ColorInput).optional(),
});

export const TableInput = z.object({
  rows: z
    .array(z.array(z.string()))
    .min(1)
    .describe("cell texts, first row is the header when header is true"),
  header: z.boolean().optional(),
  stripe: z.boolean().optional(),
  colWidths: z.array(z.number().positive()).optional(),
  borderColor: ColorInput.optional(),
});

export const ELEMENT_TYPES = [
  "frame",
  "group",
  "rect",
  "ellipse",
  "polygon",
  "star",
  "line",
  "path",
  "text",
  "image",
  "svg",
  "chart",
  "table",
  "qr",
] as const;

export const ElementInput = z.object({
  type: z.enum(ELEMENT_TYPES),
  ref: z
    .string()
    .max(40)
    .optional()
    .describe(
      "temporary name to reference this element as `parent` of later elements in the same call",
    ),
  parent: z
    .string()
    .optional()
    .describe(
      "ref of an earlier element in this call, or an existing container id; default: the call's parentId",
    ),
  ...StyleProps,
  chart: ChartInput.optional(),
  table: TableInput.optional(),
});

export type ElementSpec = z.output<typeof ElementInput>;
export type StyleSpec = { [K in keyof typeof StyleProps]?: z.output<(typeof StyleProps)[K]> };

export const PlacementInput = z.object({
  targetId: z
    .string()
    .optional()
    .describe("replace the image of this existing element instead of creating a new one"),
  parentId: z.string().optional().describe("container for a new element (default: current page)"),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  alt: z.string().optional(),
  fit: z.enum(["fill", "fit", "crop"]).optional(),
  cornerRadius: z.number().min(0).optional(),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("z-index in the parent (0 = bottom); default top"),
});
export type Placement = z.output<typeof PlacementInput>;
