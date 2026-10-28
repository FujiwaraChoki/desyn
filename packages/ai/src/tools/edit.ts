// Element tools: create (flat specs with temporary refs build nested subtrees), batch update, delete, duplicate,
// group/ungroup, roles and batch styling. Every call is one undoable transaction.
import {
  applyTransaction,
  boundsOfSelection,
  deleteNodes,
  descendants,
  duplicate,
  getNode,
  groupNodes,
  topLevelSelection,
  ungroup as ungroupBuilder,
} from "@desyn/doc-ops";
import {
  getFont,
  type Id,
  isContainerType,
  type Node,
  newId,
  nodeSchemaFor,
  type Op,
  type TextNode,
} from "@desyn/schema";
import { z } from "zod";
import { suggestFonts } from "../prompts/fonts";
import {
  assertContainer,
  buildContext,
  buildNode,
  fitGroup,
  layoutChildren,
  measureTextNodes,
} from "./build";
import { type CompactDiff, commit } from "./commit";
import { designTool } from "./define";
import { patchFor } from "./patch";
import { ElementInput, IdInput, StyleProps } from "./schemas";
import { type ToolContext, ToolInputError } from "./types";

/** Lint issues from describe() that involve the given ids (fed back so the model fixes them right away). */
export async function issuesFor(ctx: ToolContext, ids: Id[], pageId?: Id): Promise<string[]> {
  if (ids.length === 0) return [];
  const set = new Set(ids);
  try {
    const desc = await ctx.host.describe(pageId ? { pageId } : {});
    return desc.issues
      .filter((i) => i.ids.some((id) => set.has(id)) && i.severity !== "info")
      .slice(0, 8)
      .map((i) => `[${i.severity}] ${i.code}: ${i.message} (${i.ids.join(",")})`);
  } catch {
    return [];
  }
}

function fontWarnings(nodes: Node[]): string[] {
  const warnings = new Set<string>();
  for (const n of nodes) {
    if (n.type !== "text") continue;
    if (!getFont(n.style.fontFamily)) {
      warnings.add(
        `Font "${n.style.fontFamily}" is not in the self-hosted catalog; it will load from Google Fonts on demand. Similar catalog fonts: ${suggestFonts(n.style.fontFamily).join(", ")}.`,
      );
    }
  }
  return [...warnings];
}

function validate(node: Node, label: string): void {
  const schema = nodeSchemaFor(node.type);
  const parsed = schema?.safeParse(node);
  if (parsed && !parsed.success) {
    const first = parsed.error.issues[0];
    throw new ToolInputError(
      `${label}: invalid ${first?.path.join(".") || "value"} — ${first?.message ?? "invalid"}.`,
    );
  }
}

function summarizeDiff(diff: CompactDiff): string {
  const parts: string[] = [];
  if (diff.created.length) parts.push(`created ${diff.created.length}`);
  if (diff.updated.length) parts.push(`updated ${diff.updated.length}`);
  if (diff.deleted.length) parts.push(`deleted ${diff.deleted.length}`);
  if (diff.dropped.length) parts.push(`${diff.dropped.length} change(s) dropped`);
  return parts.join(", ") || "no changes";
}

/** Existing (not created by this run) content nodes in the subtrees of `ids`; bare groups do not count. */
function existingContent(ctx: ToolContext, ids: readonly Id[]): Id[] {
  const design = ctx.host.getDesign();
  const out: Id[] = [];
  for (const id of ids) {
    const node = getNode(design, id);
    if (!node) continue;
    for (const n of [node, ...descendants(design, id)]) {
      if (n.type !== "group" && !ctx.run.created.has(n.id)) out.push(n.id);
    }
  }
  return out;
}

/**
 * Deleting many existing elements needs the user's confirmation. Counts content inside the deleted subtrees, so
 * removing one wrapper frame that holds the whole design is treated like deleting everything in it.
 */
async function guardDestructive(ctx: ToolContext, action: string, ids: Id[]): Promise<void> {
  if (ctx.run.allowDestructive) return;
  const foreign = existingContent(ctx, ids);
  const page = ctx.host.page;
  const total = page ? existingContent(ctx, [page]).filter((id) => id !== page).length : 0;
  const needs =
    foreign.length > 6 || (foreign.length >= 3 && total > 0 && foreign.length / total >= 0.6);
  if (!needs) return;
  if (
    ctx.confirmDestructive &&
    (await ctx.confirmDestructive({ action, count: foreign.length, ids: foreign }))
  )
    return;
  throw new ToolInputError(
    `${action} would remove ${foreign.length} existing elements, which needs the user's confirmation.`,
    "Call ask_user to confirm (list what will be removed), or change fewer elements.",
  );
}

export function editTools(ctx: ToolContext) {
  return {
    create_elements: designTool(ctx, {
      description: [
        "Create elements in one undoable step. Elements are a flat list; nest them by giving a container a `ref` and later elements `parent: <ref>` (or an existing frame/group id).",
        "Positions are relative to the parent; ids are generated and returned per ref. Text boxes are measured automatically (omit height); omit width for short single-line text.",
        "Sensible defaults apply (role-based type sizes, readable text color on the backdrop, brand fonts). Frames with `layout` position their children automatically and hug them when width/height are omitted.",
        "Always set meaningful `name` and `role`.",
      ].join(" "),
      inputSchema: z.object({
        parentId: IdInput.optional().describe(
          "container for elements without `parent` (default: the current page)",
        ),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("z-index for the first top-level element (default: on top)"),
        elements: z.array(ElementInput).min(1).max(120),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const parentId = input.parentId ?? ctx.host.page;
        if (!parentId) throw new ToolInputError("There is no page to add elements to.");
        assertContainer(design, parentId);
        const build = buildContext(ctx.host, parentId);
        const pending = new Map<Id, Node>();
        build.pending = pending;
        const refs = new Map<string, Id>();
        const order: Node[] = [];
        const specs = new Map<Id, (typeof input.elements)[number]>();
        input.elements.forEach((spec, i) => {
          const label = `element ${i + 1}${spec.ref ? ` (${spec.ref})` : ""}`;
          let parent = parentId;
          if (spec.parent) {
            const viaRef = refs.get(spec.parent);
            if (viaRef) parent = viaRef;
            else if (getNode(design, spec.parent)) parent = spec.parent;
            else
              throw new ToolInputError(
                `${label}: parent "${spec.parent}" is neither an earlier ref nor an existing id.`,
              );
            const p = pending.get(parent) ?? getNode(design, parent);
            if (!p || !isContainerType(p.type) || p.type === "root") {
              throw new ToolInputError(
                `${label}: parent "${spec.parent}" (${p?.type}) cannot contain children; use a frame or group.`,
              );
            }
          }
          if (spec.ref && refs.has(spec.ref))
            throw new ToolInputError(`${label}: duplicate ref "${spec.ref}".`);
          const node = buildNode(spec, parent, build);
          if (spec.ref) refs.set(spec.ref, node.id);
          const parentNode = pending.get(parent);
          if (parentNode && "children" in parentNode) parentNode.children.push(node.id);
          pending.set(node.id, node);
          specs.set(node.id, spec);
          order.push(node);
        });
        // Derived geometry: text boxes, then containers deepest-first (auto-layout, group bounds, frame hug).
        await measureTextNodes(
          ctx.host,
          order.filter((n): n is TextNode => n.type === "text"),
        );
        const depth = (n: Node): number =>
          pending.has(n.parent as Id) ? 1 + depth(pending.get(n.parent as Id) as Node) : 0;
        const containers = order.filter((n) => "children" in n).sort((a, b) => depth(b) - depth(a));
        for (const c of containers) {
          const kids = (c as Node & { children: Id[] }).children.map(
            (id) => pending.get(id) as Node,
          );
          const spec = specs.get(c.id);
          if (c.type === "frame" && c.layout) {
            layoutChildren(c as typeof c & { layout: NonNullable<typeof c.layout> }, kids, {
              w: spec?.width === undefined,
              h: spec?.height === undefined,
            });
          } else if (c.type === "group") {
            fitGroup(c, kids);
          } else if (c.type === "frame") {
            if (spec?.width === undefined) c.width = Math.max(0, ...kids.map((k) => k.x + k.width));
            if (spec?.height === undefined)
              c.height = Math.max(0, ...kids.map((k) => k.y + k.height));
          }
        }
        order.forEach((n, i) => {
          validate(n, `element ${i + 1}`);
        });
        // One create op per top-level element, carrying its whole subtree in pre-order.
        const ops: Op[] = [];
        const subtreeOf = (n: Node): Node[] => [
          n,
          ...("children" in n
            ? n.children.flatMap((id) => subtreeOf(pending.get(id) as Node))
            : []),
        ];
        let index = input.index;
        for (const n of order) {
          if (pending.has(n.parent as Id)) continue;
          const op: Op = { op: "create", nodes: subtreeOf(n), parent: n.parent as Id };
          if (index !== undefined) op.index = index++;
          ops.push(op);
        }
        const { diff } = await commit(
          ctx,
          ops,
          `Create ${order.length} element${order.length === 1 ? "" : "s"}`,
        );
        const createdIds = order.map((n) => n.id);
        const warnings = [...fontWarnings(order), ...(await issuesFor(ctx, createdIds))];
        return {
          ok: true,
          summary: `Created ${order.length} element(s): ${order
            .slice(0, 6)
            .map((n) => `${n.type} "${n.name}"`)
            .join(", ")}${order.length > 6 ? "…" : ""}.`,
          refs: Object.fromEntries(refs),
          ids: ops.map((op) => (op.op === "create" ? op.nodes[0]?.id : undefined)).filter(Boolean),
          boxes: order.slice(0, 40).map((n) => ({
            id: n.id,
            name: n.name,
            x: n.x,
            y: n.y,
            width: Math.round(n.width),
            height: Math.round(n.height),
          })),
          ...(warnings.length ? { warnings } : {}),
          diff: { created: diff.created.length, dropped: diff.dropped },
        };
      },
    }),

    update_elements: designTool(ctx, {
      description:
        "Batch-update existing elements: geometry, text and typography, fills, strokes, radius, shadow, layout, roles, names, images. Only listed properties change; text boxes are re-measured. Locked elements are skipped unless the update sets locked:false.",
      inputSchema: z.object({
        updates: z
          .array(z.object({ id: IdInput, ...StyleProps }))
          .min(1)
          .max(150),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const ops: Op[] = [];
        const skipped: string[] = [];
        const ignored: string[] = [];
        for (const u of input.updates) {
          const { id, ...spec } = u;
          const node = getNode(design, id);
          if (!node) {
            skipped.push(`${id}: not found`);
            continue;
          }
          if (node.locked && spec.locked !== false) {
            skipped.push(`${id}: locked`);
            continue;
          }
          const patch = patchFor(node, spec);
          if (patch.ignored.length)
            ignored.push(`${id} (${node.type}): ${patch.ignored.join(", ")}`);
          if (patch.op?.op !== "update") continue;
          if (patch.remeasure && node.type === "text") {
            const next = { ...node, ...(patch.op.set ?? {}) } as TextNode;
            const before = { w: next.width, h: next.height };
            await measureTextNodes(ctx.host, [next]);
            const set = patch.op.set ?? {};
            if (next.width !== before.w && spec.width === undefined) set.width = next.width;
            if (next.height !== before.h && spec.height === undefined) set.height = next.height;
            if (next.height !== node.height && spec.height === undefined) set.height = next.height;
            patch.op.set = set;
          }
          ops.push(patch.op);
        }
        if (ops.length === 0) {
          return {
            ok: false,
            error: "No changes to apply.",
            ...(skipped.length ? { skipped } : {}),
            ...(ignored.length ? { ignored } : {}),
          };
        }
        const { diff } = await commit(
          ctx,
          ops,
          `Update ${ops.length} element${ops.length === 1 ? "" : "s"}`,
        );
        const warnings = await issuesFor(
          ctx,
          ops.map((o) => (o.op === "update" ? o.id : "")).filter(Boolean),
        );
        return {
          ok: true,
          summary: `Updated ${diff.updated.length} element(s).`,
          changes: diff.updated,
          ...(skipped.length ? { skipped } : {}),
          ...(ignored.length ? { ignored } : {}),
          ...(warnings.length ? { warnings } : {}),
        };
      },
    }),

    delete_elements: designTool(ctx, {
      description:
        "Delete elements (and their children). Groups left empty are removed. Deleting many existing elements requires the user's confirmation.",
      inputSchema: z.object({
        ids: z.array(IdInput).min(1).max(200),
        reason: z.string().optional(),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const targets = topLevelSelection(design, input.ids).filter((id) => {
          const n = getNode(design, id);
          return n && n.type !== "page" && n.type !== "root";
        });
        if (targets.length === 0)
          throw new ToolInputError(
            "None of these ids are deletable elements (use delete_page for pages).",
          );
        const locked = targets.filter((id) => getNode(design, id)?.locked);
        const deletable = targets.filter((id) => !locked.includes(id));
        if (deletable.length === 0)
          throw new ToolInputError(
            "All targets are locked.",
            "Unlock them first if the user asked to delete them.",
          );
        await guardDestructive(ctx, "Deleting", deletable);
        const tx = deleteNodes(design, deletable);
        const { diff } = await commit(ctx, tx.ops, tx.label);
        return {
          ok: true,
          summary: `Deleted ${diff.deleted.length} element(s).`,
          deleted: diff.deleted,
          ...(locked.length ? { skippedLocked: locked } : {}),
        };
      },
    }),

    duplicate_elements: designTool(ctx, {
      description:
        "Duplicate elements (with fresh ids), each copy above its original. With count > 1 copies are laid out in a row or column with a gap.",
      inputSchema: z.object({
        ids: z.array(IdInput).min(1).max(50),
        count: z.number().int().min(1).max(24).default(1),
        direction: z.enum(["right", "down", "offset"]).default("offset"),
        gap: z.number().min(0).default(24),
        offset: z
          .object({ x: z.number(), y: z.number() })
          .optional()
          .describe('used with direction "offset" (default 16,16)'),
      }),
      async execute(input) {
        let working = ctx.host.getDesign();
        const ids = topLevelSelection(working, input.ids);
        if (ids.length === 0) throw new ToolInputError("No such elements.");
        const box = boundsOfSelection(working, ids);
        const ops: Op[] = [];
        const copies: Id[] = [];
        for (let k = 1; k <= input.count; k++) {
          const offset =
            input.direction === "right"
              ? { x: ((box?.width ?? 0) + input.gap) * k, y: 0 }
              : input.direction === "down"
                ? { x: 0, y: ((box?.height ?? 0) + input.gap) * k }
                : { x: (input.offset?.x ?? 16) * k, y: (input.offset?.y ?? 16) * k };
          const tx = duplicate(working, ids, { offset });
          working = applyTransaction(working, tx).design;
          ops.push(...tx.ops);
          for (const op of tx.ops)
            if (op.op === "create" && op.nodes[0]) copies.push(op.nodes[0].id);
        }
        await commit(ctx, ops, `Duplicate ${ids.length} element${ids.length === 1 ? "" : "s"}`);
        return {
          ok: true,
          summary: `Created ${copies.length} cop${copies.length === 1 ? "y" : "ies"}.`,
          copies,
        };
      },
    }),

    group_elements: designTool(ctx, {
      description:
        "Group elements (on one page) into a new group placed in their common container; positions are preserved.",
      inputSchema: z.object({
        ids: z.array(IdInput).min(1).max(100),
        name: z.string().optional(),
        role: z.string().optional(),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const groupId = newId();
        const tx = groupNodes(design, input.ids, {
          groupId,
          ...(input.name ? { name: input.name } : {}),
        });
        const ops = [...tx.ops];
        if (input.role) ops.push({ op: "update", id: groupId, set: { role: input.role } });
        await commit(ctx, ops, "Group");
        return {
          ok: true,
          summary: `Grouped ${input.ids.length} element(s) into ${groupId}.`,
          groupId,
        };
      },
    }),

    ungroup: designTool(ctx, {
      description: "Dissolve groups/frames: children move to the parent and keep their position.",
      inputSchema: z.object({ ids: z.array(IdInput).min(1).max(50) }),
      async execute(input) {
        const tx = ungroupBuilder(ctx.host.getDesign(), input.ids);
        if (tx.ops.length === 0) throw new ToolInputError("None of these are groups or frames.");
        const { diff } = await commit(ctx, tx.ops, "Ungroup");
        return { ok: true, summary: `Ungrouped; ${diff.deleted.length} container(s) removed.` };
      },
    }),

    set_roles: designTool(ctx, {
      description:
        "Set semantic roles, names and alt text so the design is understandable (roles drive resize, localize, brand mapping and critique).",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              id: IdInput,
              role: z.string().optional(),
              name: z.string().optional(),
              alt: z.string().optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const ops: Op[] = [];
        for (const item of input.items) {
          const node = getNode(design, item.id);
          if (!node) continue;
          const set: Record<string, unknown> = {};
          if (item.role !== undefined && item.role !== node.role) set.role = item.role;
          if (item.name !== undefined && item.name !== node.name) set.name = item.name;
          if (item.alt !== undefined && item.alt !== node.alt) set.alt = item.alt;
          if (Object.keys(set).length) ops.push({ op: "update", id: item.id, set });
        }
        if (ops.length === 0) return { ok: true, summary: "Roles and names were already set." };
        await commit(ctx, ops, "Label layers");
        return { ok: true, summary: `Labelled ${ops.length} element(s).` };
      },
    }),

    set_style: designTool(ctx, {
      description:
        "Apply the same style to many elements at once (fill, stroke, radius, shadow, opacity, blend, typography, text color). Groups apply to their descendants; properties that do not fit an element type are skipped.",
      inputSchema: z.object({
        ids: z.array(IdInput).min(1).max(200),
        style: z.object({
          fill: StyleProps.fill,
          fills: StyleProps.fills,
          stroke: StyleProps.stroke,
          cornerRadius: StyleProps.cornerRadius,
          shadow: StyleProps.shadow,
          blur: StyleProps.blur,
          opacity: StyleProps.opacity,
          blend: StyleProps.blend,
          fontFamily: StyleProps.fontFamily,
          fontSize: StyleProps.fontSize,
          fontWeight: StyleProps.fontWeight,
          italic: StyleProps.italic,
          color: StyleProps.color,
          align: StyleProps.align,
          lineHeight: StyleProps.lineHeight,
          letterSpacing: StyleProps.letterSpacing,
          textCase: StyleProps.textCase,
        }),
        includeChildren: z.boolean().default(false).describe("also style descendants of frames"),
      }),
      async execute(input) {
        const design = ctx.host.getDesign();
        const targets = new Set<Id>();
        for (const id of input.ids) {
          const node = getNode(design, id);
          if (!node) continue;
          if (
            node.type === "group" ||
            (input.includeChildren && "children" in node && node.type !== "page")
          ) {
            for (const d of descendants(design, id)) if (d.type !== "group") targets.add(d.id);
            if (node.type !== "group") targets.add(id);
          } else {
            targets.add(id);
          }
        }
        const ops: Op[] = [];
        for (const id of targets) {
          const node = getNode(design, id) as Node;
          if (node.locked) continue;
          const patch = patchFor(node, input.style);
          if (patch.op?.op !== "update") continue;
          if (patch.remeasure && node.type === "text") {
            const next = { ...node, ...(patch.op.set ?? {}) } as TextNode;
            await measureTextNodes(ctx.host, [next]);
            patch.op.set = { ...(patch.op.set ?? {}), width: next.width, height: next.height };
          }
          ops.push(patch.op);
        }
        if (ops.length === 0)
          throw new ToolInputError(
            "The style does not apply to any of these elements (or nothing changes).",
          );
        const { diff } = await commit(ctx, ops, "Restyle");
        return {
          ok: true,
          summary: `Restyled ${diff.updated.length} element(s): ${summarizeDiff(diff)}.`,
          changed: diff.updated.map((u) => u.id),
        };
      },
    }),
  };
}
