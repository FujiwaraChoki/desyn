// Read tools: understand the canvas (structure, text, typography, grid, issues), the selection, a rendered
// preview, and targeted queries. All user-authored text is wrapped as untrusted data.

import { approxBounds, findNodes, getNode, pageOf, pages } from "@desyn/doc-ops";
import type { Description, DNode, Id, Node } from "@desyn/schema";
import { z } from "zod";
import { fillColor, textColor, textOf } from "../design/paint";
import { guardName, guardStrings, wrapUntrusted } from "../prompts/guard";
import { bytesToBase64 } from "../util/bytes";
import { designTool } from "./define";
import { IdInput } from "./schemas";
import { type ToolContext, ToolInputError } from "./types";

interface CompactNode {
  id: Id;
  type: string;
  name: string;
  role?: string;
  box: [number, number, number, number];
  rot?: number;
  text?: string;
  font?: string;
  fill?: string;
  image?: string;
  semantic?: string;
  flags?: string[];
  hidden?: true;
  locked?: true;
  opacity?: number;
  children?: CompactNode[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function compactNode(d: DNode): CompactNode {
  const out: CompactNode = {
    id: d.id,
    type: d.type,
    name: guardName(d.name),
    box: [r1(d.box.x), r1(d.box.y), r1(d.box.w), r1(d.box.h)],
  };
  if (d.role) out.role = d.role;
  if (d.box.rotation) out.rot = d.box.rotation;
  if (d.text !== undefined) out.text = d.text;
  if (d.font)
    out.font = `${d.font.family} ${d.font.weight} ${d.font.size}px ${d.font.color} ${d.font.align}${d.font.lines && d.font.lines > 1 ? ` ${d.font.lines} lines` : ""}`;
  if (d.fill && d.fill !== "none") out.fill = d.fill;
  if (d.image)
    out.image = `${d.image.kind ?? "image"} asset ${d.image.assetId}${d.image.alt ? ` alt=${wrapUntrusted("alt-text", d.image.alt)}` : ""}`;
  if (d.semantic) out.semantic = d.semantic;
  if (d.flags?.length) out.flags = d.flags;
  if (!d.visible) out.hidden = true;
  if (d.locked) out.locked = true;
  if (d.opacity < 1) out.opacity = d.opacity;
  if (d.children?.length) out.children = d.children.map(compactNode);
  return out;
}

export function compactDescription(desc: Description, options: { issues?: number } = {}) {
  return {
    page: { ...desc.page },
    tree: guardStrings(desc.tree.map(compactNode), "design-text", new Set(["text"])),
    palette: desc.palette.map((p) => `${p.color} ${Math.round(p.share * 100)}%`),
    fonts: desc.fonts.map((f) => `${f.family} (${f.weights.join("/")}) ×${f.usedBy}`),
    typography: desc.typography,
    grid: {
      margins: desc.grid.margins,
      ...(desc.grid.spacingRhythm ? { spacingRhythm: desc.grid.spacingRhythm } : {}),
    },
    hierarchy: desc.hierarchy.slice(0, 6).map((h) => `${h.rank}. ${h.id} — ${h.reason}`),
    issues: desc.issues
      .slice(0, options.issues ?? 20)
      .map((i) => `[${i.severity}] ${i.code} ${i.ids.join(",")}: ${i.message}`),
  };
}

function pageList(ctx: ToolContext) {
  const design = ctx.host.getDesign();
  const current = ctx.host.page;
  return pages(design).map((p, index) => ({
    id: p.id,
    index,
    name: p.name,
    size: `${p.width}x${p.height} ${p.unit}`,
    ...(p.id === current ? { current: true } : {}),
  }));
}

/** Detailed properties of one node for read_selection (enough to restyle it precisely). */
function nodeDetails(node: Node, ctx: ToolContext): Record<string, unknown> {
  const design = ctx.host.getDesign();
  const b = approxBounds(design, node.id);
  const out: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: guardName(node.name),
    parent: node.parent,
    local: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation,
    },
    ...(b ? { pageBox: [r1(b.x), r1(b.y), r1(b.width), r1(b.height)] } : {}),
    opacity: node.opacity,
  };
  if (node.role) out.role = node.role;
  if (node.effects.length) out.effects = node.effects;
  if (node.type === "text") {
    out.text = wrapUntrusted("design-text", textOf(node));
    out.style = { ...node.style, color: textColor(node, design) };
    out.paragraph = node.paragraph;
    out.autoResize = node.autoResize;
    if (node.runs.length > 1 || node.runs[0]?.style)
      out.runs = node.runs.map((r) => ({ ...r, text: wrapUntrusted("design-text", r.text) }));
  }
  if ("fills" in node) out.fills = node.fills;
  if ("strokes" in node && node.strokes?.length) out.strokes = node.strokes;
  if ("cornerRadius" in node) out.cornerRadius = node.cornerRadius;
  if ("children" in node) {
    out.children = node.children;
    if ("layout" in node && node.layout) out.layout = node.layout;
    if ("clip" in node) out.clip = node.clip;
  }
  if (node.type === "image") {
    const asset = design.assets[node.assetId];
    out.image = {
      assetId: node.assetId,
      fit: node.fit,
      crop: node.crop,
      assetSize: asset?.width ? `${asset.width}x${asset.height}` : undefined,
      ...(node.alt ? { alt: wrapUntrusted("alt-text", node.alt) } : {}),
    };
  }
  if (node.type === "svg")
    out.svg = node.markup ? `${node.markup.length} chars inline markup` : `asset ${node.assetId}`;
  if (node.meta?.slot) out.slot = node.meta.slot;
  return out;
}

export function readTools(ctx: ToolContext) {
  return {
    read_design: designTool(ctx, {
      description:
        "Read the design: pages, the element tree of a page (ids, types, names, roles, page-space boxes [x,y,w,h], text, fonts, fills, inferred semantic groups, flags), palette, fonts, type scale, margins, visual hierarchy and lint issues. Call this first and after large changes.",
      inputSchema: z.object({
        pageId: IdInput.optional().describe("default: the page the user is viewing"),
        maxDepth: z.number().int().min(1).max(12).optional(),
      }),
      async execute(input) {
        const desc = await ctx.host.describe({
          ...(input.pageId ? { pageId: input.pageId } : {}),
          ...(input.maxDepth ? { maxDepth: input.maxDepth } : {}),
          selection: ctx.host.selection,
        });
        const design = ctx.host.getDesign();
        return {
          ok: true,
          summary: `${design.kind} "${design.name}", page ${desc.page.index + 1}/${desc.design.pageCount} (${desc.page.width}x${desc.page.height}), ${desc.tree.length} top-level elements, ${desc.issues.length} issues.`,
          design: {
            id: design.id,
            name: wrapUntrusted("design-name", design.name),
            kind: design.kind,
            pages: pageList(ctx),
            brandKit: ctx.host.brand?.name ?? null,
            selection: ctx.host.selection,
          },
          ...compactDescription(desc),
        };
      },
    }),

    read_selection: designTool(ctx, {
      description:
        "Read the user's current selection in detail (exact styles, text runs, fills, layout) — use before editing selected elements.",
      inputSchema: z.object({}),
      async execute() {
        const design = ctx.host.getDesign();
        const ids = ctx.host.selection;
        if (ids.length === 0) return { ok: true, summary: "Nothing is selected.", selection: [] };
        const nodes = ids
          .map((id) => getNode(design, id))
          .filter((n): n is Node => n !== undefined);
        return {
          ok: true,
          summary: `${nodes.length} selected: ${nodes.map((n) => `${n.type} "${guardName(n.name)}"`).join(", ")}.`,
          selection: nodes.map((n) => nodeDetails(n, ctx)),
        };
      },
    }),

    render_preview: designTool(ctx, {
      description:
        "Render a page (or a region) to an image and look at it. Use after building or restyling to judge the visual result; previews are small (≤ 1024 px).",
      inputSchema: z.object({
        pageId: IdInput.optional(),
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            w: z.number().positive(),
            h: z.number().positive(),
          })
          .optional(),
        maxSize: z.number().int().min(256).max(1600).optional(),
      }),
      async execute(input) {
        const pageId = input.pageId ?? ctx.host.page;
        const r = await ctx.host.render({
          ...(pageId ? { pageId } : {}),
          ...(input.region ? { region: input.region } : {}),
          maxSize: input.maxSize ?? 1024,
        });
        const previewId = `p${ctx.run.previews.size + 1}`;
        ctx.run.previews.set(previewId, { base64: bytesToBase64(r.bytes), mime: r.mime });
        ctx.emit({
          type: "preview",
          runId: ctx.run.runId,
          mime: r.mime,
          width: r.width,
          height: r.height,
          bytes: r.bytes,
          ...(pageId ? { pageId } : {}),
        });
        return {
          ok: true,
          summary: `Rendered ${r.width}x${r.height} preview.`,
          previewId,
          width: r.width,
          height: r.height,
        };
      },
      toModelOutput: ({ output }) => {
        const preview =
          output.ok && typeof output.previewId === "string"
            ? ctx.run.previews.get(output.previewId)
            : undefined;
        if (!preview) return { type: "json", value: JSON.parse(JSON.stringify(output)) };
        return {
          type: "content",
          value: [
            { type: "text", text: output.ok ? output.summary : output.error },
            { type: "file", mediaType: preview.mime, data: { type: "data", data: preview.base64 } },
          ],
        };
      },
    }),

    query_elements: designTool(ctx, {
      description:
        "Find elements by type, role, name, text, color, font or size (across one page or the whole design). Returns ids with boxes and a style summary.",
      inputSchema: z.object({
        pageId: IdInput.optional().describe(
          'page to search; "all" searches every page; default current page',
        ),
        type: z.string().optional(),
        role: z.string().optional(),
        nameContains: z.string().optional(),
        textContains: z.string().optional(),
        color: z.string().optional().describe("hex; matches fills and text colors"),
        fontFamily: z.string().optional(),
        minFontSize: z.number().optional(),
        maxFontSize: z.number().optional(),
        inside: IdInput.optional().describe("only descendants of this container"),
        includeHidden: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const root =
          input.inside ?? (input.pageId === "all" ? "root" : (input.pageId ?? ctx.host.page));
        if (!root || !getNode(design, root))
          throw new ToolInputError(`Unknown container "${String(root)}".`);
        const color = input.color?.toLowerCase();
        const matches = findNodes(
          design,
          (n) => {
            if (n.type === "root" || n.type === "page" || n.id === root) return false;
            if (!input.includeHidden && !n.visible) return false;
            if (input.type && n.type !== input.type) return false;
            if (input.role && n.role !== input.role) return false;
            if (
              input.nameContains &&
              !n.name.toLowerCase().includes(input.nameContains.toLowerCase())
            )
              return false;
            if (
              input.textContains &&
              !(
                n.type === "text" &&
                textOf(n).toLowerCase().includes(input.textContains.toLowerCase())
              )
            )
              return false;
            if (
              input.fontFamily &&
              !(
                n.type === "text" &&
                n.style.fontFamily.toLowerCase() === input.fontFamily.toLowerCase()
              )
            )
              return false;
            if (
              input.minFontSize !== undefined &&
              !(n.type === "text" && n.style.fontSize >= input.minFontSize)
            )
              return false;
            if (
              input.maxFontSize !== undefined &&
              !(n.type === "text" && n.style.fontSize <= input.maxFontSize)
            )
              return false;
            if (color) {
              const c =
                n.type === "text"
                  ? textColor(n, design)
                  : "fills" in n
                    ? fillColor(n.fills, design)
                    : undefined;
              if (!c || c.slice(0, 7) !== color.slice(0, 7)) return false;
            }
            return true;
          },
          root,
        );
        const items = matches.slice(0, input.limit).map((n) => {
          const b = approxBounds(design, n.id);
          return {
            id: n.id,
            type: n.type,
            name: guardName(n.name),
            ...(n.role ? { role: n.role } : {}),
            page: pageOf(design, n.id)?.id,
            ...(b ? { box: [r1(b.x), r1(b.y), r1(b.width), r1(b.height)] } : {}),
            ...(n.type === "text"
              ? {
                  text: wrapUntrusted("design-text", textOf(n).slice(0, 160)),
                  font: `${n.style.fontFamily} ${n.style.fontWeight} ${n.style.fontSize}px ${textColor(n, design) ?? ""}`,
                }
              : "fills" in n
                ? { fill: fillColor(n.fills, design) ?? "none" }
                : {}),
          };
        });
        return {
          ok: true,
          summary: `${matches.length} match${matches.length === 1 ? "" : "es"}${matches.length > items.length ? ` (showing ${items.length})` : ""}.`,
          items,
        };
      },
    }),
  };
}
