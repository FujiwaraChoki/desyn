// arrange: align, distribute, stack, grid, auto-layout, match size, z-order and centering, built on the doc-ops
// arrangement builders so results match the editor's own commands exactly.
import {
  alignNodes,
  applyTransaction,
  approxBounds,
  Builder,
  bringForward,
  bringToFront,
  distribute,
  getNode,
  matchSize,
  sendBackward,
  sendToBack,
  tidyGrid,
  topLevelSelection,
  wrapInFrame,
} from "@desyn/doc-ops";
import { type AutoLayout, type Design, type Id, type Node, newId, type Op } from "@desyn/schema";
import { z } from "zod";
import { layoutChildren, toLayout } from "./build";
import { commit } from "./commit";
import { designTool } from "./define";
import { IdInput, LayoutInput } from "./schemas";
import { type ToolContext, ToolInputError } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;

function stackOps(
  design: Design,
  ids: Id[],
  direction: "vertical" | "horizontal",
  gap: number,
  align: "start" | "center" | "end" | "none",
): Op[] {
  const sel = topLevelSelection(design, ids).filter((id) => !getNode(design, id)?.locked);
  if (sel.length < 2) throw new ToolInputError("Stacking needs at least two unlocked elements.");
  const vertical = direction === "vertical";
  const items = sel.map((id) => ({
    id,
    box: approxBounds(design, id) as NonNullable<ReturnType<typeof approxBounds>>,
  }));
  items.sort((a, b) => (vertical ? a.box.y - b.box.y : a.box.x - b.box.x));
  const crossStart = Math.min(...items.map((i) => (vertical ? i.box.x : i.box.y)));
  const crossEnd = Math.max(
    ...items.map((i) => (vertical ? i.box.x + i.box.width : i.box.y + i.box.height)),
  );
  const b = new Builder(design);
  let cursor = vertical ? (items[0]?.box.y ?? 0) : (items[0]?.box.x ?? 0);
  for (const it of items) {
    const size = vertical ? it.box.height : it.box.width;
    const crossSize = vertical ? it.box.width : it.box.height;
    const crossPos = vertical ? it.box.x : it.box.y;
    const targetCross =
      align === "start"
        ? crossStart
        : align === "end"
          ? crossEnd - crossSize
          : align === "center"
            ? (crossStart + crossEnd) / 2 - crossSize / 2
            : crossPos;
    const dMain = cursor - (vertical ? it.box.y : it.box.x);
    const dCross = targetCross - crossPos;
    b.translateInPage(it.id, vertical ? dCross : dMain, vertical ? dMain : dCross);
    cursor += size + gap;
  }
  b.refitGroups(sel);
  return b.build("Stack").ops;
}

/** Update ops that apply an auto-layout to a frame and position its current children. */
function autoLayoutOps(design: Design, frameId: Id, layout: AutoLayout, hug: boolean): Op[] {
  const frame = getNode(design, frameId);
  if (frame?.type !== "frame") throw new ToolInputError(`"${frameId}" is not a frame.`);
  const kids = frame.children.map((id) => ({ ...(getNode(design, id) as Node) }));
  const box = { width: frame.width, height: frame.height, layout };
  layoutChildren(box, kids, { w: hug, h: hug });
  const ops: Op[] = [
    { op: "update", id: frameId, set: { layout, width: r2(box.width), height: r2(box.height) } },
  ];
  for (const k of kids) {
    const orig = getNode(design, k.id) as Node;
    const set: Record<string, unknown> = {};
    for (const key of ["x", "y", "width", "height"] as const)
      if (Math.abs(orig[key] - k[key]) > 0.005) set[key] = r2(k[key]);
    if (Object.keys(set).length) ops.push({ op: "update", id: k.id, set });
  }
  return ops;
}

export function arrangeTools(ctx: ToolContext) {
  return {
    arrange: designTool(ctx, {
      description: [
        "Arrange elements:",
        "align (left|center|right|top|middle|bottom, to selection or page);",
        "distribute (horizontal|vertical, even or fixed spacing);",
        "stack (place in a vertical/horizontal sequence with a gap and cross alignment);",
        "grid (tidy into columns);",
        "auto-layout (apply row/column/grid auto-layout to a frame, or wrap the elements in a new auto-layout frame);",
        "match-size; z-order (forward|backward|front|back); center (center on the page).",
      ].join(" "),
      inputSchema: z.object({
        ids: z.array(IdInput).min(1).max(200),
        action: z.enum([
          "align",
          "distribute",
          "stack",
          "grid",
          "auto-layout",
          "match-size",
          "z-order",
          "center",
        ]),
        alignment: z
          .enum(["left", "center", "right", "top", "middle", "bottom"])
          .optional()
          .describe("align"),
        to: z
          .enum(["selection", "page"])
          .optional()
          .describe("align: reference (single elements always align to the page)"),
        axis: z
          .enum(["horizontal", "vertical"])
          .optional()
          .describe("distribute / stack direction"),
        spacing: z
          .number()
          .min(0)
          .optional()
          .describe("distribute: fixed gap; stack/grid: gap (default 24)"),
        crossAlign: z
          .enum(["start", "center", "end", "none"])
          .optional()
          .describe("stack: cross-axis alignment"),
        columns: z.number().int().min(1).optional().describe("grid columns"),
        layout: LayoutInput.optional().describe("auto-layout settings"),
        hug: z
          .boolean()
          .optional()
          .describe("auto-layout: resize the frame to hug its content (default true)"),
        dimension: z.enum(["width", "height", "both"]).optional().describe("match-size"),
        reference: z
          .string()
          .optional()
          .describe('match-size reference: "first", "last", "largest", "smallest" or an id'),
        order: z.enum(["forward", "backward", "front", "back"]).optional().describe("z-order"),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        let ops: Op[] = [];
        let label = "Arrange";
        let extra: Record<string, unknown> = {};
        switch (input.action) {
          case "align": {
            if (!input.alignment) throw new ToolInputError("align needs `alignment`.");
            const tx = alignNodes(
              design,
              input.ids,
              input.alignment,
              input.to ? { to: input.to } : {},
            );
            ops = tx.ops;
            label = tx.label;
            break;
          }
          case "center": {
            const t1 = alignNodes(design, input.ids, "center", { to: "page" });
            const mid = applyTransaction(design, t1).design;
            const t2 = alignNodes(mid, input.ids, "middle", { to: "page" });
            ops = [...t1.ops, ...t2.ops];
            label = "Center on page";
            break;
          }
          case "distribute": {
            const tx = distribute(
              design,
              input.ids,
              input.axis ?? "horizontal",
              input.spacing !== undefined ? { spacing: input.spacing } : {},
            );
            ops = tx.ops;
            label = tx.label;
            break;
          }
          case "stack":
            ops = stackOps(
              design,
              input.ids,
              input.axis ?? "vertical",
              input.spacing ?? 24,
              input.crossAlign ?? "none",
            );
            label = "Stack";
            break;
          case "grid": {
            const tx = tidyGrid(design, input.ids, {
              gap: input.spacing ?? 24,
              ...(input.columns ? { columns: input.columns } : {}),
            });
            ops = tx.ops;
            label = tx.label;
            break;
          }
          case "match-size": {
            const tx = matchSize(design, input.ids, {
              ...(input.dimension ? { dimension: input.dimension } : {}),
              ...(input.reference ? { to: input.reference } : {}),
            });
            ops = tx.ops;
            label = tx.label;
            break;
          }
          case "z-order": {
            const fn = {
              forward: bringForward,
              backward: sendBackward,
              front: bringToFront,
              back: sendToBack,
            }[input.order ?? "front"];
            const tx = fn(design, input.ids);
            ops = tx.ops;
            label = tx.label;
            break;
          }
          case "auto-layout": {
            const layout = toLayout(
              input.layout ?? {
                mode: input.axis === "horizontal" ? "row" : "column",
                gap: input.spacing ?? 16,
                padding: 0,
                mainAlign: "start",
                crossAlign: "start",
              },
            ) as AutoLayout;
            const single = input.ids.length === 1 ? getNode(design, input.ids[0] as Id) : undefined;
            if (single?.type === "frame") {
              ops = autoLayoutOps(design, single.id, layout, input.hug ?? false);
              extra = { frameId: single.id };
            } else {
              const frameId = newId();
              const wrap = wrapInFrame(design, input.ids, {
                frameId,
                name: "Auto layout",
                padding: layout.padding[0],
              });
              const wrapped = applyTransaction(design, wrap).design;
              ops = [...wrap.ops, ...autoLayoutOps(wrapped, frameId, layout, input.hug ?? true)];
              extra = { frameId };
            }
            label = "Auto layout";
            break;
          }
        }
        if (ops.length === 0) return { ok: true, summary: "Already arranged; nothing changed." };
        const { diff } = await commit(ctx, ops, label);
        return {
          ok: true,
          summary: `${label}: moved/resized ${diff.updated.length} element(s).`,
          ...extra,
          changes: diff.updated.slice(0, 20),
        };
      },
    }),
  };
}
