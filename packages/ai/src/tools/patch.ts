// Turns a friendly style/property patch into an `update` op for an existing node, respecting the node's type.
import {
  type AutoLayout,
  type Id,
  isShapedType,
  type Node,
  newId,
  type Op,
  type TextNode,
} from "@desyn/schema";
import { sanitizeSvg } from "../media/svg";
import {
  paragraphFrom,
  runsFrom,
  textStyleFrom,
  toEffects,
  toFills,
  toLayout,
  toStroke,
} from "./build";
import type { StyleSpec } from "./schemas";

export interface PatchResult {
  op?: Op;
  /** Keys requested that do not apply to this node type. */
  ignored: string[];
  /** The text box must be re-measured (content or typography changed). */
  remeasure: boolean;
}

const GEOMETRY = [
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "visible",
  "locked",
  "blend",
  "name",
  "role",
  "link",
  "constraints",
  "sizing",
  "alt",
  "notes",
] as const;
const TEXT_KEYS = new Set([
  "text",
  "runs",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "italic",
  "color",
  "letterSpacing",
  "textCase",
  "underline",
  "align",
  "lineHeight",
  "direction",
  "autoResize",
  "verticalAlign",
  "maxLines",
]);

export function patchFor(node: Node, spec: StyleSpec): PatchResult {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const ignored: string[] = [];
  let remeasure = false;
  for (const key of GEOMETRY) if (spec[key] !== undefined) set[key] = spec[key];
  if (spec.slot !== undefined) set.meta = { ...(node.meta ?? {}), slot: spec.slot };
  if (spec.anim) set.anim = spec.anim.map((a) => ({ id: newId(), ...a }));
  const effects = toEffects(spec, node.effects);
  if (effects) set.effects = effects;

  const fills = toFills(spec);
  if (node.type === "text") {
    const t = node as TextNode;
    const touchesText = Object.keys(spec).some(
      (k) => TEXT_KEYS.has(k) && spec[k as keyof StyleSpec] !== undefined,
    );
    if (touchesText || fills) {
      const style = textStyleFrom(spec, t.style);
      if (JSON.stringify(style) !== JSON.stringify(t.style)) set.style = style;
      const paragraph = paragraphFrom(spec, t.paragraph);
      if (JSON.stringify(paragraph) !== JSON.stringify(t.paragraph)) set.paragraph = paragraph;
      const runs = runsFrom(spec);
      if (runs) {
        // Keep the first run's style override when replacing plain text.
        const keep = spec.runs ? undefined : t.runs[0]?.style;
        set.runs =
          keep && runs.length === 1 && runs[0] ? [{ text: runs[0].text, style: keep }] : runs;
      } else if (spec.color || fills) {
        // A new color must win over per-run color overrides.
        set.runs = t.runs.map((r) => {
          if (!r.style?.fills) return r;
          const { fills: _f, ...rest } = r.style;
          return Object.keys(rest).length ? { text: r.text, style: rest } : { text: r.text };
        });
      }
      if (spec.autoResize) set.autoResize = spec.autoResize;
      if (spec.verticalAlign) set.verticalAlign = spec.verticalAlign;
      if (spec.maxLines !== undefined) set.maxLines = spec.maxLines;
      remeasure = true;
    }
    if (spec.stroke !== undefined) set.strokes = toStroke(spec.stroke);
    if (spec.width !== undefined) remeasure = true;
  } else {
    for (const k of TEXT_KEYS) {
      if (
        spec[k as keyof StyleSpec] !== undefined &&
        !(k === "color" && (node.type === "line" || node.type === "qr"))
      )
        ignored.push(k);
    }
  }

  if (isShapedType(node.type)) {
    if (fills) set.fills = fills;
    if (spec.stroke !== undefined) set.strokes = toStroke(spec.stroke);
    if (spec.cornerRadius !== undefined) set.cornerRadius = spec.cornerRadius;
  } else if (node.type === "page") {
    if (fills) set.background = fills;
  } else if (node.type === "image") {
    if (spec.cornerRadius !== undefined) set.cornerRadius = spec.cornerRadius;
    if (spec.stroke !== undefined) set.strokes = toStroke(spec.stroke);
    if (spec.fit) set.fit = spec.fit;
    if (spec.imageShape) set.shape = spec.imageShape;
    if (spec.assetId) {
      set.assetId = spec.assetId;
      unset.push("crop");
    }
    if (fills) ignored.push("fill");
  } else if (node.type === "line") {
    const color =
      spec.color ?? (spec.stroke && spec.stroke !== "none" ? spec.stroke.color : undefined);
    if (spec.stroke !== undefined || color) {
      const current = node.strokes[0];
      const width =
        spec.stroke && spec.stroke !== "none" ? spec.stroke.width : (current?.width ?? 2);
      set.strokes =
        spec.stroke === "none"
          ? []
          : [
              {
                ...(current ?? { align: "center", cap: "round", join: "round" }),
                fills: [{ type: "solid", color: color ?? "#111111" }],
                width,
              },
            ];
    }
    if (spec.startCap) set.startCap = spec.startCap;
    if (spec.endCap) set.endCap = spec.endCap;
  } else if (node.type === "svg") {
    if (spec.markup) {
      set.markup = sanitizeSvg(spec.markup).svg;
      unset.push("assetId");
    }
    if (spec.assetId) {
      set.assetId = spec.assetId;
      unset.push("markup");
    }
    if (fills) ignored.push("fill");
  } else if (node.type === "qr") {
    if (spec.color) set.fg = spec.color;
    if (spec.background) set.bg = spec.background;
    if (spec.qrData) set.data = spec.qrData;
  } else if (fills && node.type !== "text") {
    ignored.push("fill");
  }

  if ("children" in node && node.type !== "root") {
    if (spec.clip !== undefined && node.type !== "group") set.clip = spec.clip;
    if (spec.layout !== undefined && node.type === "frame") {
      const layout = toLayout(spec.layout);
      if (layout) set.layout = layout as AutoLayout;
      else unset.push("layout");
    }
  } else if (spec.clip !== undefined || spec.layout !== undefined) {
    ignored.push("clip/layout");
  }
  if (spec.d !== undefined) {
    if (node.type === "path") set.paths = [{ d: spec.d, fillRule: "nonzero" }];
    else ignored.push("d");
  }
  if (spec.sides !== undefined && node.type === "polygon") set.sides = spec.sides;
  if (spec.points !== undefined && node.type === "star") set.points = spec.points;
  if (spec.innerRatio !== undefined && node.type === "star") set.innerRatio = spec.innerRatio;

  // Only keys whose value actually changes.
  const record = node as unknown as Record<string, unknown>;
  for (const k of Object.keys(set))
    if (JSON.stringify(record[k]) === JSON.stringify(set[k])) delete set[k];
  const realUnset = unset.filter((k) => k in record);
  if (Object.keys(set).length === 0 && realUnset.length === 0) return { ignored, remeasure: false };
  const op: Op = { op: "update", id: node.id as Id };
  if (Object.keys(set).length > 0) op.set = set;
  if (realUnset.length > 0) op.unset = realUnset;
  return { op, ignored, remeasure };
}
