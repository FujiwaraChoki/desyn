// Brand and page tools.
import { addPage, deletePage, getNode, pages, reorderPages, resizePage } from "@desyn/doc-ops";
import { getPreset, type Id, newId, type Op, PAGE_PRESETS } from "@desyn/schema";
import { z } from "zod";
import { brandOps } from "../design/brand";
import { reflowPage } from "../design/reflow";
import { commit } from "./commit";
import { designTool } from "./define";
import { issuesFor } from "./edit";
import { ColorInput, IdInput } from "./schemas";
import { type ToolContext, ToolInputError } from "./types";

function resolveSize(input: { preset?: string; width?: number; height?: number }) {
  if (input.preset) {
    const preset = getPreset(input.preset);
    if (!preset) {
      const near = PAGE_PRESETS.filter((p) => p.id.includes(input.preset?.split("-")[0] ?? ""))
        .slice(0, 8)
        .map((p) => p.id);
      throw new ToolInputError(
        `Unknown preset "${input.preset}".`,
        near.length ? `Try one of: ${near.join(", ")}` : undefined,
      );
    }
    return { width: preset.width, height: preset.height, unit: preset.unit, preset };
  }
  if (input.width && input.height) return { width: input.width, height: input.height };
  return undefined;
}

export function pageTools(ctx: ToolContext) {
  return {
    apply_brand: designTool(ctx, {
      description:
        'Apply the attached brand kit ("make this match my brand"): maps colors by usage (backgrounds, surfaces, accents/CTAs, other shapes), swaps heading/body fonts, replaces or adds the logo, then fixes text contrast. Layout stays as is.',
      inputSchema: z.object({
        scope: z.enum(["design", "page", "elements"]).default("page"),
        ids: z.array(IdInput).optional().describe('scope "elements": which elements'),
        colors: z.boolean().default(true),
        fonts: z.boolean().default(true),
        logo: z.enum(["replace", "add", "none"]).default("replace"),
      }),
      async execute(input) {
        const brand = ctx.host.brand;
        if (!brand)
          throw new ToolInputError(
            "No brand kit is attached to this design.",
            "Ask the user to pick a brand kit, or apply colors/fonts with set_style.",
          );
        const design = ctx.host.getDesign();
        const pageIds =
          input.scope === "design"
            ? pages(design).map((p) => p.id)
            : ctx.host.page
              ? [ctx.host.page]
              : undefined;
        const report = brandOps(design, brand, {
          ...(pageIds ? { pageIds } : {}),
          ...(input.scope === "elements" && input.ids ? { ids: input.ids } : {}),
          colors: input.colors,
          fonts: input.fonts,
          logo: input.logo,
        });
        if (report.ops.length === 0)
          return { ok: true, summary: "The design already matches the brand." };
        await commit(ctx, report.ops, `Apply brand ${brand.name}`);
        const warnings = await issuesFor(ctx, report.contrastFixes);
        return {
          ok: true,
          summary: `Applied ${brand.name}: ${report.recolored} recolored, ${report.fontsChanged} fonts swapped, ${report.logos.length} logo(s), ${report.contrastFixes.length} contrast fix(es).`,
          colorMap: report.colorMap,
          ...(warnings.length ? { warnings } : {}),
        };
      },
    }),

    add_page: designTool(ctx, {
      description:
        "Add a page (slide, card back, story frame). Size from a preset id, explicit size, or copied from an existing page.",
      inputSchema: z.object({
        name: z.string().optional(),
        preset: z
          .string()
          .optional()
          .describe("page preset id, e.g. instagram-story, presentation-16-9, business-card-us"),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        like: IdInput.optional().describe("copy size and background from this page"),
        index: z.number().int().min(0).optional(),
        background: ColorInput.optional(),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const pageId = newId();
        const size = resolveSize(input);
        const tx = addPage(design, {
          pageId,
          ...(input.name ? { name: input.name } : {}),
          ...(size?.preset
            ? { preset: size.preset }
            : size
              ? { width: size.width, height: size.height }
              : {}),
          ...(input.like ? { like: input.like } : {}),
          ...(input.index !== undefined ? { index: input.index } : {}),
          ...(input.background ? { background: [{ type: "solid", color: input.background }] } : {}),
        });
        await commit(ctx, tx.ops, tx.label);
        const page = getNode(ctx.host.getDesign(), pageId);
        return {
          ok: true,
          summary: `Added page ${pageId} (${page?.width}x${page?.height}).`,
          pageId,
        };
      },
    }),

    delete_page: designTool(ctx, {
      description:
        "Delete a page and everything on it (needs the user's confirmation unless this run created it).",
      inputSchema: z.object({ pageId: IdInput }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const page = getNode(design, input.pageId);
        if (page?.type !== "page") throw new ToolInputError(`"${input.pageId}" is not a page.`);
        if (
          !ctx.run.created.has(input.pageId) &&
          page.children.length > 0 &&
          !ctx.run.allowDestructive
        ) {
          const ok = await ctx.confirmDestructive?.({
            action: "Deleting a page",
            count: page.children.length,
            ids: [input.pageId],
          });
          if (!ok)
            throw new ToolInputError(
              "Deleting a page with content needs the user's confirmation.",
              "Call ask_user first.",
            );
        }
        const tx = deletePage(design, input.pageId);
        await commit(ctx, tx.ops, tx.label);
        return { ok: true, summary: `Deleted page "${page.name}".` };
      },
    }),

    reorder_pages: designTool(ctx, {
      description: "Reorder pages; `order` lists every page id in the new order.",
      inputSchema: z.object({ order: z.array(IdInput).min(1) }),
      async execute(input) {
        const tx = reorderPages(ctx.host.getDesign(), input.order);
        if (tx.ops.length === 0) return { ok: true, summary: "Pages were already in that order." };
        await commit(ctx, tx.ops, tx.label);
        return { ok: true, summary: "Reordered pages." };
      },
    }),

    resize_page: designTool(ctx, {
      description:
        'Resize a page. strategy "reflow" (default) adapts the layout intelligently: backdrops cover, edge elements keep their corners, text re-wraps, side-by-side layouts restack when the orientation flips. Other strategies: scale (fit), fill (cover), stretch, center, none.',
      inputSchema: z.object({
        pageId: IdInput.optional(),
        preset: z.string().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        strategy: z
          .enum(["reflow", "scale", "fill", "stretch", "center", "none"])
          .default("reflow"),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const pageId = (input.pageId ?? ctx.host.page) as Id | undefined;
        if (!pageId || getNode(design, pageId)?.type !== "page")
          throw new ToolInputError("Unknown page.");
        const size = resolveSize(input);
        if (!size) throw new ToolInputError("Give a preset or width and height.");
        let ops: Op[];
        let detail = "";
        if (input.strategy === "reflow") {
          const result = await reflowPage(design, pageId, size, {
            measure: (items) => ctx.host.measure(items),
          });
          ops = result.ops;
          if (size.unit)
            ops.push({
              op: "update",
              id: pageId,
              set: {
                unit: size.unit,
                ...(size.preset?.bleed !== undefined ? { bleed: size.preset.bleed } : {}),
              },
            });
          detail = ` (${result.layout})`;
        } else {
          ops = resizePage(design, pageId, size, {
            strategy: input.strategy,
            ...(size.unit ? { unit: size.unit } : {}),
          }).ops;
        }
        await commit(ctx, ops, `Resize page to ${size.width}x${size.height}`);
        const warnings = await issuesFor(
          ctx,
          (getNode(ctx.host.getDesign(), pageId) as { children: Id[] }).children,
          pageId,
        );
        return {
          ok: true,
          summary: `Resized page to ${size.width}x${size.height}${detail}.`,
          ...(warnings.length ? { warnings } : {}),
        };
      },
    }),
  };
}
