// JSON Schema documents derived from the zod schemas (one per public type). Used by scripts/gen-json-schema.ts and
// by tests that keep packages/schema/json-schema/*.json in sync. zod drops refinements when converting, so the one
// refinement in the model (an svg node needs assetId or markup) is added back as an `anyOf` of `required` lists.
import { z } from "zod";
import * as S from "./zod";

export const JSON_SCHEMA_BASE_URL = "https://desyn.app/schema/v1";

const EXPORTS: Record<string, z.ZodType> = {
  Design: S.DesignSchema,
  DesignStyles: S.DesignStylesSchema,
  DesignMeta: S.DesignMetaSchema,
  AssetRef: S.AssetRefSchema,
  Node: S.NodeSchema,
  RootNode: S.RootNodeSchema,
  PageNode: S.PageNodeSchema,
  FrameNode: S.FrameNodeSchema,
  GroupNode: S.GroupNodeSchema,
  BooleanNode: S.BooleanNodeSchema,
  RectNode: S.RectNodeSchema,
  EllipseNode: S.EllipseNodeSchema,
  PolygonNode: S.PolygonNodeSchema,
  StarNode: S.StarNodeSchema,
  LineNode: S.LineNodeSchema,
  PathNode: S.PathNodeSchema,
  TextNode: S.TextNodeSchema,
  ImageNode: S.ImageNodeSchema,
  SvgNode: S.SvgNodeSchema,
  VideoNode: S.VideoNodeSchema,
  AudioNode: S.AudioNodeSchema,
  ChartNode: S.ChartNodeSchema,
  TableNode: S.TableNodeSchema,
  QrNode: S.QrNodeSchema,
  Fill: S.FillSchema,
  Stop: S.StopSchema,
  Stroke: S.StrokeSchema,
  Effect: S.EffectSchema,
  Animation: S.AnimationSchema,
  AutoLayout: S.AutoLayoutSchema,
  ImageAdjust: S.ImageAdjustSchema,
  TextStyle: S.TextStyleSchema,
  TextRun: S.TextRunSchema,
  ParagraphStyle: S.ParagraphStyleSchema,
  Op: S.OpSchema,
  Transaction: S.TransactionSchema,
  Description: S.DescriptionSchema,
  DNode: S.DNodeSchema,
  Issue: S.IssueSchema,
  IssueCode: S.IssueCodeSchema,
};

const NOTES: Record<string, string> = {
  SvgNode: "An svg node requires assetId or markup.",
  Node: "Any document node, discriminated by `type`. An svg node requires assetId or markup.",
  Design:
    "A Desyn design (docs/DOCUMENT_MODEL.md). Structural invariants (tree consistency, page nesting) are checked by validateDesign, not by this schema.",
};

// Shared building blocks become named $defs instead of being inlined everywhere.
const SHARED: Record<string, z.ZodType> = {
  Id: S.IdSchema,
  NodeId: S.NodeIdSchema,
  Color: S.ColorSchema,
  ColorRef: S.ColorRefSchema,
  BlendMode: S.BlendModeSchema,
  Fill: S.FillSchema,
  Stop: S.StopSchema,
  Stroke: S.StrokeSchema,
  Effect: S.EffectSchema,
  Animation: S.AnimationSchema,
  AutoLayout: S.AutoLayoutSchema,
  ImageAdjust: S.ImageAdjustSchema,
  TextStyle: S.TextStyleSchema,
  ParagraphStyle: S.ParagraphStyleSchema,
  TextRun: S.TextRunSchema,
  AssetRef: S.AssetRefSchema,
  Node: S.NodeSchema,
  ...Object.fromEntries(
    Object.entries(S.NODE_SCHEMAS).map(([type, schema]) => [
      `${type[0]?.toUpperCase()}${type.slice(1)}Node`,
      schema,
    ]),
  ),
  Op: S.OpSchema,
  DNode: S.DNodeSchema,
  Issue: S.IssueSchema,
};

const SVG_SOURCE_REQUIRED = [{ required: ["assetId"] }, { required: ["markup"] }];

/** Adds the svg "assetId or markup" rule to every svg node schema object inside `value` (in place). */
function addSvgSourceRule(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) addSvgSourceRule(v);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const rec = value as Record<string, unknown>;
  const type = (rec.properties as { type?: { const?: unknown } } | undefined)?.type;
  if (rec.type === "object" && type?.const === "svg" && !("anyOf" in rec)) {
    rec.anyOf = SVG_SOURCE_REQUIRED.map((r) => ({ required: [...r.required] }));
  }
  for (const v of Object.values(rec)) addSvgSourceRule(v);
}

export function jsonSchemaDocuments(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(EXPORTS)) {
    const metadata = z.registry<{ id: string }>();
    for (const [id, shared] of Object.entries(SHARED))
      if (shared !== schema) metadata.add(shared, { id });
    const doc = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      metadata,
    }) as Record<string, unknown>;
    addSvgSourceRule(doc);
    const { $schema, ...rest } = doc;
    out[name] = {
      $schema,
      $id: `${JSON_SCHEMA_BASE_URL}/${name}.json`,
      title: name,
      ...(NOTES[name] ? { description: NOTES[name] } : {}),
      ...rest,
    };
  }
  return out;
}
