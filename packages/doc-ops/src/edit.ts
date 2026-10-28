// Content edit builders: fills, text, image replacement.
import {
  type AssetRef,
  type Design,
  defaultStroke,
  type Fill,
  type Id,
  isColor,
  isShapedType,
  type Node,
  type TextNode,
  type TextRun,
  type Transaction,
} from "@desyn/schema";
import { Builder } from "./builder";
import { descendants, getNode } from "./tree";
import type { TxOptions } from "./tx";
import { DocOpsError, deepEqual } from "./util";

function stripRunFills(runs: TextRun[]): TextRun[] {
  return runs.map((run) => {
    if (!run.style || !("fills" in run.style)) return run;
    const { fills: _drop, ...style } = run.style;
    return Object.keys(style).length > 0 ? { ...run, style } : { text: run.text };
  });
}

/**
 * Sets the paint of nodes: `fills` of shapes and frames, the text color (and clears per-run colors), page
 * backgrounds, line strokes and QR foregrounds. Groups apply to their paintable descendants. Other node types
 * are left unchanged.
 */
export function setFill(
  design: Design,
  ids: Id[],
  fill: Fill | Fill[],
  options: TxOptions = {},
): Transaction {
  const fills = Array.isArray(fill) ? fill : [fill];
  const b = new Builder(design);
  const targets = new Set<Id>();
  for (const id of ids) {
    const node = getNode(design, id);
    if (!node) continue;
    if (node.type === "group") {
      for (const d of descendants(design, id)) if (d.type !== "group") targets.add(d.id);
    } else {
      targets.add(id);
    }
  }
  for (const id of targets) {
    const node = b.node(id);
    if (isShapedType(node.type)) {
      b.update(id, { fills });
    } else if (node.type === "text") {
      const runs = stripRunFills(node.runs);
      b.update(
        id,
        deepEqual(runs, node.runs)
          ? { style: { ...node.style, fills } }
          : { style: { ...node.style, fills }, runs },
      );
    } else if (node.type === "page") {
      b.update(id, { background: fills });
    } else if (node.type === "line") {
      const strokes =
        node.strokes.length > 0
          ? node.strokes.map((s) => ({ ...s, fills }))
          : [defaultStroke({ fills, width: 2 })];
      b.update(id, { strokes });
    } else if (node.type === "qr") {
      const first = fills[0];
      if (first?.type === "solid" && typeof first.color === "string" && isColor(first.color)) {
        b.update(id, { fg: first.color });
      }
    }
  }
  return b.build("Change color", options);
}

export interface SetTextOptions extends TxOptions {
  /** Keep the first run's style override for the new text (default true). */
  keepRunStyle?: boolean;
}

/** Replaces a text node's content with plain text ("\n" separates paragraphs). */
export function setText(
  design: Design,
  id: Id,
  text: string,
  options: SetTextOptions = {},
): Transaction {
  const node = getNode(design, id);
  if (node?.type !== "text") throw new DocOpsError(`setText: "${id}" is not a text node`);
  const style = options.keepRunStyle === false ? undefined : (node as TextNode).runs[0]?.style;
  const b = new Builder(design);
  b.update(id, { runs: [style ? { text, style } : { text }] });
  return b.build("Edit text", options);
}

export interface ReplaceImageOptions extends TxOptions {
  /** Asset record to add to (or refresh in) design.assets in the same transaction. */
  asset?: AssetRef;
  /** Drop the old crop and matte (default true); they describe the previous image. */
  resetCrop?: boolean;
}

/**
 * Points an image / svg / video node at another asset. Shapes, frames and pages with an image fill get their
 * first image fill replaced.
 */
export function replaceImage(
  design: Design,
  id: Id,
  assetId: Id,
  options: ReplaceImageOptions = {},
): Transaction {
  const node = getNode(design, id);
  if (!node) throw new DocOpsError(`replaceImage: "${id}" does not exist`);
  const b = new Builder(design);
  if (options.asset) {
    if (options.asset.id !== assetId)
      throw new DocOpsError("replaceImage: asset.id must equal assetId");
    if (!deepEqual(design.assets[assetId], options.asset)) {
      b.push({ op: "asset", set: { [assetId]: options.asset } });
    }
  }
  const reset = options.resetCrop !== false;
  const replaceFill = (fills: Fill[]): Fill[] | null => {
    const at = fills.findIndex((f) => f.type === "image");
    if (at < 0) return null;
    return fills.map((f, i) => (i === at && f.type === "image" ? { ...f, assetId } : f));
  };
  switch (node.type) {
    case "image":
      b.update(id, { assetId }, reset ? ["crop", "maskAssetId"] : []);
      break;
    case "svg":
      b.update(id, { assetId }, ["markup"]);
      break;
    case "video":
      b.update(id, { assetId }, reset ? ["posterAssetId"] : []);
      break;
    case "page": {
      const next = replaceFill(node.background);
      if (!next) throw new DocOpsError("replaceImage: page has no image background");
      b.update(id, { background: next });
      break;
    }
    default: {
      const fills = (node as Node & { fills?: Fill[] }).fills;
      const next = fills ? replaceFill(fills) : null;
      if (!next) throw new DocOpsError(`replaceImage: "${id}" has no image to replace`);
      b.update(id, { fills: next });
    }
  }
  return b.build("Replace image", options);
}
