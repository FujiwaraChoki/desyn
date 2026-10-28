import {
  type AssetRef,
  type Color,
  type CreateOp,
  createAudio,
  createBoolean,
  createChart,
  createEllipse,
  createFrame,
  createGroup,
  createImage,
  createLine,
  createPage,
  createPath,
  createPolygon,
  createQr,
  createRect,
  createStar,
  createSvg,
  createTable,
  createText,
  createVideo,
  defaultParagraph,
  defaultTextStyle,
  type Id,
  isContainerType,
  isId,
  type Node,
  newId,
  type Op,
  solid,
  type TextNode,
  type Transaction,
  type TransactionSource,
} from "@desyn/schema";
import type { TransactionInput } from "./client";

// Helpers to build transactions with the @desyn/schema factories. `NodeInput` is a friendly node shape: any
// subset of a node's fields plus a few shorthands; missing fields come from the factory defaults, nested
// `children` become a subtree in one `create` op.

/** A partial node: `type` plus any node fields, nested children and shorthands. */
export type NodeInput = { type: Exclude<Node["type"], "root"> } & Record<string, unknown> & {
    id?: string;
    name?: string;
    children?: NodeInput[];
    /** text: the text content (one run). */
    text?: string;
    /** Shapes / frames: a solid fill color (shorthand for `fills`). Text: the text color. */
    fill?: Color;
    /** Text shorthands (merged into `style` / `paragraph`). */
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    italic?: boolean;
    color?: Color;
    letterSpacing?: number;
    align?: "left" | "center" | "right" | "justify";
    lineHeight?: number;
  };

const TEXT_SHORTHANDS = [
  "text",
  "fill",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "italic",
  "color",
  "letterSpacing",
  "align",
  "lineHeight",
] as const;

type Factory = (overrides: Record<string, unknown>) => Node;

const FACTORIES: Record<string, Factory> = {
  page: (o) => createPage(o),
  frame: (o) => createFrame(o),
  group: (o) => createGroup(o),
  boolean: (o) => createBoolean(o),
  rect: (o) => createRect(o),
  ellipse: (o) => createEllipse(o),
  polygon: (o) => createPolygon(o),
  star: (o) => createStar(o),
  line: (o) => createLine(o),
  path: (o) => createPath(o),
  text: (o) => createText(o),
  image: (o) => createImage(o as Parameters<typeof createImage>[0]),
  svg: (o) => createSvg(o as Parameters<typeof createSvg>[0]),
  video: (o) => createVideo(o as Parameters<typeof createVideo>[0]),
  audio: (o) => createAudio(o as Parameters<typeof createAudio>[0]),
  chart: (o) => createChart(o),
  table: (o) => createTable(o),
  qr: (o) => createQr(o),
};

export class NodeInputError extends Error {
  override readonly name = "NodeInputError";
}

function expandTextShorthands(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of TEXT_SHORTHANDS) delete out[key];
  const style = { ...defaultTextStyle(), ...((input.style as object | undefined) ?? {}) };
  const color = (input.color ?? input.fill) as Color | undefined;
  if (color !== undefined) style.fills = [solid(color)];
  if (typeof input.fontFamily === "string") style.fontFamily = input.fontFamily;
  if (typeof input.fontSize === "number") style.fontSize = input.fontSize;
  if (typeof input.fontWeight === "number") style.fontWeight = input.fontWeight;
  if (input.italic === true) style.fontStyle = "italic";
  if (typeof input.letterSpacing === "number") style.letterSpacing = input.letterSpacing;
  out.style = style;
  const paragraph = { ...defaultParagraph(), ...((input.paragraph as object | undefined) ?? {}) };
  if (typeof input.align === "string")
    paragraph.align = input.align as TextNode["paragraph"]["align"];
  if (typeof input.lineHeight === "number") {
    paragraph.lineHeight =
      input.lineHeight <= 4
        ? { unit: "percent", value: Math.round(input.lineHeight * 100) }
        : { unit: "px", value: input.lineHeight };
  }
  out.paragraph = paragraph;
  if (typeof input.text === "string") out.text = input.text;
  return out;
}

/** A complete node from a NodeInput (children are not expanded here; see `expandNode`). */
export function nodeFromInput(input: NodeInput, parent: Id): Node {
  const factory = FACTORIES[input.type];
  if (!factory) throw new NodeInputError(`Unknown node type "${String(input.type)}".`);
  if (input.id !== undefined && !isId(input.id)) {
    throw new NodeInputError(`Node id "${input.id}" must be 12 characters [a-z0-9].`);
  }
  if (
    (input.type === "image" || input.type === "video" || input.type === "audio") &&
    typeof input.assetId !== "string"
  ) {
    throw new NodeInputError(`A ${input.type} node needs an assetId (the AssetRef id).`);
  }
  if (
    input.type === "svg" &&
    typeof input.assetId !== "string" &&
    typeof input.markup !== "string"
  ) {
    throw new NodeInputError("An svg node needs an assetId or markup.");
  }
  const { children: _children, ...rest } = input;
  let fields: Record<string, unknown> = rest;
  if (input.type === "text") {
    fields = expandTextShorthands(rest);
  } else if (typeof input.fill === "string") {
    const { fill, ...others } = rest;
    fields = { ...others, fills: [solid(fill as Color)] };
  }
  const node = factory({ ...fields, parent }) as Node & { children?: Id[] };
  if (input.id === undefined) node.id = newId();
  if (isContainerType(node.type)) node.children = [];
  return node;
}

/** Expand a NodeInput tree into the flat `nodes` list of a create op (subtree root first). */
export function expandNode(input: NodeInput, parent: Id): Node[] {
  const out: Node[] = [];
  const visit = (n: NodeInput, p: Id): Id => {
    const node = nodeFromInput(n, p) as Node & { children?: Id[] };
    out.push(node);
    if (n.children && n.children.length > 0) {
      if (!node.children) throw new NodeInputError(`A ${node.type} node cannot have children.`);
      const kids = node.children;
      for (const child of n.children) kids.push(visit(child, node.id));
    }
    return node.id;
  };
  visit(input, parent);
  const seen = new Set<string>();
  for (const n of out) {
    if (seen.has(n.id)) throw new NodeInputError(`Duplicate node id "${n.id}".`);
    seen.add(n.id);
  }
  return out;
}

/** A `create` op for a NodeInput subtree under `parent` (index omitted: on top). */
export function createOp(parent: Id, input: NodeInput, index?: number): CreateOp {
  const op: CreateOp = { op: "create", parent, nodes: expandNode(input, parent) };
  if (index !== undefined) op.index = index;
  return op;
}

/** Fluent transaction builder. */
export class TransactionBuilder {
  readonly ops: Op[] = [];

  /** Create a subtree from a full Node (with `nodes` for descendants) or a NodeInput. Returns the root id. */
  create(
    parent: Id,
    node: Node | NodeInput,
    opts: { index?: number; descendants?: Node[] } = {},
  ): Id {
    let op: CreateOp;
    if (opts.descendants || isFullNode(node)) {
      op = { op: "create", parent, nodes: [node as Node, ...(opts.descendants ?? [])] };
      if (opts.index !== undefined) op.index = opts.index;
    } else {
      op = createOp(parent, node as NodeInput, opts.index);
    }
    this.ops.push(op);
    return (op.nodes[0] as Node).id;
  }

  update(id: Id, set: Record<string, unknown>, unset?: string[]): this {
    this.ops.push(
      unset && unset.length > 0 ? { op: "update", id, set, unset } : { op: "update", id, set },
    );
    return this;
  }

  patch(id: Id, path: (string | number)[], value: unknown): this {
    this.ops.push({ op: "patch", id, path, value });
    return this;
  }

  delete(...ids: Id[]): this {
    for (const id of ids) this.ops.push({ op: "delete", id });
    return this;
  }

  move(id: Id, parent: Id, index?: number): this {
    this.ops.push(
      index === undefined ? { op: "move", id, parent } : { op: "move", id, parent, index },
    );
    return this;
  }

  /** Add asset refs (e.g. `asset.assetRef` from the assets API) and/or remove refs. */
  asset(set: AssetRef[] | Record<Id, AssetRef>, remove?: Id[]): this {
    const map = Array.isArray(set) ? Object.fromEntries(set.map((a) => [a.id, a])) : set;
    this.ops.push({ op: "asset", set: map, ...(remove && remove.length > 0 ? { remove } : {}) });
    return this;
  }

  styles(path: (string | number)[], value: unknown): this {
    this.ops.push({ op: "styles", path, value });
    return this;
  }

  doc(set: Extract<Op, { op: "doc" }>["set"], unset?: "brandKitId"[]): this {
    this.ops.push(unset ? { op: "doc", set, unset } : { op: "doc", set });
    return this;
  }

  /** The transaction to commit (`id` is generated: commits are idempotent on it). */
  build(
    label: string,
    opts: { source?: TransactionSource; agent?: string; id?: Id } = {},
  ): TransactionInput {
    if (this.ops.length === 0) throw new Error("The transaction has no ops.");
    return {
      id: opts.id ?? newId(),
      label,
      ops: [...this.ops],
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.agent ? { actor: { agent: opts.agent } } : {}),
    };
  }
}

function isFullNode(node: Node | NodeInput): node is Node {
  const n = node as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    typeof n.name === "string" &&
    "parent" in n &&
    typeof n.opacity === "number" &&
    typeof n.blend === "string" &&
    Array.isArray(n.effects)
  );
}

/** A complete transaction for local use with @desyn/doc-ops `applyTransaction`. */
export function toTransaction(
  input: TransactionInput,
  source: TransactionSource = "ai",
): Transaction {
  return {
    id: input.id ?? newId(),
    label: input.label ?? "API edit",
    ops: input.ops,
    source: input.source ?? source,
    ts: input.ts ?? Date.now(),
    ...(input.actor ? { actor: input.actor } : {}),
  };
}

/** Turn friendly create ops (`node` with nested children) into document-model ops. */
export function normalizeOps(ops: Record<string, unknown>[]): Op[] {
  return ops.map((raw, index) => {
    if (raw.op === "create" && raw.node !== undefined) {
      if (typeof raw.parent !== "string") {
        throw new NodeInputError(
          `ops[${index}]: a create op needs "parent" (a page or container id).`,
        );
      }
      const { node, ...rest } = raw;
      try {
        return { ...rest, nodes: expandNode(node as NodeInput, raw.parent) } as Op;
      } catch (err) {
        throw new NodeInputError(`ops[${index}]: ${(err as Error).message}`);
      }
    }
    return raw as unknown as Op;
  });
}
