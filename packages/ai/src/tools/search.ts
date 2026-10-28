// Search tools: stock photos (Unsplash/Pexels), icons (Iconify) and templates, with placement on the canvas.
import { applyOps, childIds, cloneSubtree, getNode, pages, zIndex } from "@desyn/doc-ops";
import { type Design, type Id, type Node, type Op, ROOT_ID } from "@desyn/schema";
import { z } from "zod";
import { brandOps } from "../design/brand";
import { coverCrop } from "../design/crop";
import { wrapUntrusted } from "../prompts/guard";
import { placementOps } from "./assets";
import { currentPage } from "./build";
import { commit } from "./commit";
import { designTool } from "./define";
import { ColorInput, PlacementInput } from "./schemas";
import { type StockPhoto, type ToolContext, ToolInputError } from "./types";

function templateSlotOps(
  design: Design,
  rootIds: Id[],
  slots: { slot: string; text?: string; assetId?: string }[],
): Op[] {
  const ops: Op[] = [];
  const all: Node[] = [];
  const walk = (id: Id) => {
    const n = getNode(design, id);
    if (!n) return;
    all.push(n);
    if ("children" in n) for (const c of n.children) walk(c);
  };
  for (const id of rootIds) walk(id);
  for (const s of slots) {
    for (const n of all.filter((x) => x.meta?.slot === s.slot)) {
      if (s.text !== undefined && n.type === "text") {
        const style = n.runs[0]?.style;
        ops.push({
          op: "update",
          id: n.id,
          set: { runs: [style ? { text: s.text, style } : { text: s.text }] },
        });
      }
      if (s.assetId && n.type === "image") {
        const asset = design.assets[s.assetId];
        ops.push({
          op: "update",
          id: n.id,
          set: {
            assetId: s.assetId,
            crop: coverCrop(asset?.width, asset?.height, n.width, n.height),
          },
        });
      }
    }
  }
  return ops;
}

export function searchTools(ctx: ToolContext) {
  return {
    search_stock: designTool(ctx, {
      description:
        "Search stock photos (Unsplash, Pexels) or place one: call with `query` to get results, then call again with `place: { id, …placement }` to download it, add attribution and place it as an image layer (or replace placement.targetId).",
      inputSchema: z.object({
        query: z.string().optional(),
        orientation: z.enum(["landscape", "portrait", "square"]).optional(),
        color: z.string().optional().describe("Unsplash color filter name or Pexels hex"),
        count: z.number().int().min(1).max(30).default(12),
        place: PlacementInput.extend({
          id: z.string().describe('result id, e.g. "unsplash:abc123"'),
        }).optional(),
      }),
      async execute(input) {
        const stock = ctx.search?.stock;
        if (!stock)
          throw new ToolInputError(
            "Stock photo search is not configured (UNSPLASH_ACCESS_KEY / PEXELS_API_KEY).",
            "Generate the image with generate_image instead.",
          );
        if (input.place) {
          const photo = ctx.run.stockResults.get(input.place.id) as StockPhoto | undefined;
          if (!photo)
            throw new ToolInputError(
              `Unknown stock result "${input.place.id}".`,
              "Search first, then place one of the returned ids.",
            );
          const file = await stock.download(photo, ctx.signal);
          const asset = await ctx.host.assets.upload(file.bytes, file.mime, {
            name: photo.description.slice(0, 60) || `${photo.provider} photo`,
            source: "stock",
            width: photo.width,
            height: photo.height,
            attribution: { author: photo.author, license: photo.license, url: photo.sourceUrl },
          });
          const { id: _id, ...placement } = input.place;
          const { ops, nodeId } = placementOps(ctx, asset, placement, {
            defaultName: "Photo",
            role: "photo",
            alt: photo.description || "Stock photo",
          });
          await commit(ctx, ops, "Place stock photo");
          return {
            ok: true,
            summary: `Placed photo by ${photo.author} (${photo.provider}) as ${nodeId}.`,
            nodeId,
            assetId: asset.id,
            attribution: `${photo.author} / ${photo.license}`,
          };
        }
        if (!input.query) throw new ToolInputError("Give a query or a result to place.");
        const results = await stock.search({
          query: input.query,
          count: input.count,
          ...(input.orientation ? { orientation: input.orientation } : {}),
          ...(input.color ? { color: input.color } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        for (const r of results) ctx.run.stockResults.set(r.id, r);
        return {
          ok: true,
          summary: `${results.length} photo(s) for "${input.query}".`,
          results: results.map((r) => ({
            id: r.id,
            description: wrapUntrusted("stock", r.description),
            size: `${r.width}x${r.height}`,
            color: r.color,
            author: r.author,
            thumb: r.thumbUrl,
          })),
        };
      },
    }),

    search_icons: designTool(ctx, {
      description:
        "Search icons (Lucide, Tabler, Phosphor) or place one: with `query` returns icon ids; with `place: { icon, color, …placement }` adds the icon as an SVG layer.",
      inputSchema: z.object({
        query: z.string().optional(),
        collections: z
          .array(z.string())
          .optional()
          .describe('icon sets, default ["lucide","tabler","ph"]'),
        limit: z.number().int().min(1).max(100).default(24),
        place: PlacementInput.extend({
          icon: z.string().describe('icon id like "lucide:sun"'),
          color: ColorInput.optional(),
        }).optional(),
      }),
      async execute(input) {
        const icons = ctx.search?.icons;
        if (!icons)
          throw new ToolInputError(
            "Icon search is not available.",
            "Draw the icon with generate_svg (kind icon).",
          );
        if (input.place) {
          const { icon, color, ...placement } = input.place;
          const markup = await icons.svg(icon, {
            ...(color ? { color } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const page = currentPage(ctx.host);
          const size =
            placement.width ??
            placement.height ??
            Math.round(Math.min(page.width, page.height) * 0.06);
          const bytes = new TextEncoder().encode(markup);
          const asset = await ctx.host.assets.upload(bytes, "image/svg+xml", {
            name: icon,
            kind: "svg",
            source: "stock",
            width: 24,
            height: 24,
            attribution: {
              license: "Iconify (open-source icon set)",
              url: `https://icon-sets.iconify.design/${icon.replace(":", "/")}/`,
            },
          });
          const { ops, nodeId } = placementOps(
            ctx,
            asset,
            { width: size, height: size, ...placement },
            {
              defaultName: `Icon ${icon.split(":")[1] ?? icon}`,
              role: "icon",
              alt: icon.split(":")[1] ?? icon,
              svgMarkup: markup,
            },
          );
          await commit(ctx, ops, "Add icon");
          return { ok: true, summary: `Placed ${icon} as ${nodeId}.`, nodeId };
        }
        if (!input.query) throw new ToolInputError("Give a query or an icon to place.");
        const results = await icons.search(input.query, {
          limit: input.limit,
          ...(input.collections ? { prefixes: input.collections } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return {
          ok: true,
          summary: `${results.length} icon(s) for "${input.query}".`,
          icons: results.map((r) => r.id),
        };
      },
    }),

    search_templates: designTool(ctx, {
      description:
        "Search the template library by prompt (optionally by design kind). Returns template ids and titles.",
      inputSchema: z.object({
        query: z.string().min(2),
        kind: z.string().optional(),
        limit: z.number().int().min(1).max(30).default(10),
      }),
      async execute(input) {
        const templates = ctx.search?.templates;
        if (!templates)
          throw new ToolInputError("Template search is not available in this context.");
        const results = await templates.search(input.query, {
          limit: input.limit,
          ...(input.kind ? { kind: input.kind as Design["kind"] } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return {
          ok: true,
          summary: `${results.length} template(s) for "${input.query}".`,
          templates: results.map((t) => ({
            id: t.id,
            title: wrapUntrusted("template", t.title),
            kind: t.kind,
            premium: t.premium ?? false,
            ...(t.width ? { size: `${t.width}x${t.height}` } : {}),
          })),
        };
      },
    }),

    apply_template: designTool(ctx, {
      description:
        "Apply a template as editable layers: replace the current page's content or add it as a new page. Optionally fill named slots (text or asset ids) and apply the brand kit.",
      inputSchema: z.object({
        templateId: z.string(),
        mode: z.enum(["replace-page", "new-page"]).default("new-page"),
        pageIndex: z.number().int().min(0).default(0).describe("which template page"),
        slots: z
          .array(
            z.object({
              slot: z.string(),
              text: z.string().optional(),
              assetId: z.string().optional(),
            }),
          )
          .optional(),
        applyBrand: z.boolean().default(false),
      }),
      async execute(input) {
        const templates = ctx.search?.templates;
        if (!templates) throw new ToolInputError("Templates are not available in this context.");
        const template = await templates.get(input.templateId, ctx.signal);
        const tPage = pages(template)[input.pageIndex];
        if (!tPage) throw new ToolInputError(`Template has no page ${input.pageIndex + 1}.`);
        const design = ctx.host.getDesign();
        const assets = Object.fromEntries(
          Object.entries(template.assets).filter(([id]) => !design.assets[id]),
        );
        const ops: Op[] = [];
        if (Object.keys(assets).length) ops.push({ op: "asset", set: assets });
        let pageId: Id;
        let roots: Id[];
        if (input.mode === "new-page") {
          const current = ctx.host.page;
          const index = current ? zIndex(design, current) + 1 : childIds(design, ROOT_ID).length;
          const { op } = cloneSubtree(template, tPage.id, {
            parent: ROOT_ID,
            index,
            name: tPage.name || "Template",
          });
          ops.push(op);
          pageId = op.nodes[0]?.id as Id;
          roots = op.nodes[0] && "children" in op.nodes[0] ? [...op.nodes[0].children] : [];
        } else {
          const page = currentPage(ctx.host);
          pageId = page.id;
          const existing = [...page.children];
          const foreign = existing.filter((id) => !ctx.run.created.has(id));
          if (foreign.length > 0 && !ctx.run.allowDestructive) {
            const ok = await ctx.confirmDestructive?.({
              action: "Replacing the page with a template",
              count: foreign.length,
              ids: foreign,
            });
            if (!ok)
              throw new ToolInputError(
                "Replacing the page would delete its current content; that needs the user's confirmation.",
                'Use mode "new-page", or ask_user first.',
              );
          }
          for (const id of existing) ops.push({ op: "delete", id });
          ops.push({
            op: "update",
            id: page.id,
            set: {
              width: tPage.width,
              height: tPage.height,
              background: tPage.background,
              unit: tPage.unit,
              bleed: tPage.bleed,
            },
          });
          roots = [];
          tPage.children.forEach((childId, i) => {
            const { op } = cloneSubtree(template, childId, { parent: page.id, index: i });
            ops.push(op);
            if (op.nodes[0]) roots.push(op.nodes[0].id);
          });
        }
        // Slots and brand are computed on the design as it will be after the template lands.
        const staged = applyOps(design, ops).design;
        if (input.slots?.length) ops.push(...templateSlotOps(staged, roots, input.slots));
        if (input.applyBrand && ctx.host.brand) {
          const branded = applyOps(design, ops).design;
          ops.push(...brandOps(branded, ctx.host.brand, { pageIds: [pageId] }).ops);
        }
        await commit(ctx, ops, `Apply template`);
        return {
          ok: true,
          summary: `Applied template ${input.templateId} (${input.mode}); page ${pageId} now has ${roots.length} top-level layers.`,
          pageId,
        };
      },
    }),
  };
}
