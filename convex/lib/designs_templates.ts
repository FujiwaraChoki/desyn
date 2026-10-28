import { type Design, type Id as DocId, type Node, newId, ROOT_ID } from "@desyn/schema";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { errors } from "./errors";

// Template documents: chunked storage of the template Design JSON and copying it into a fresh design.

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type DbCtx = QueryCtx | MutationCtx;

/** Max characters per templateDesigns part (documents must stay below 1 MiB). */
export const TEMPLATE_PART_CHARS = 700_000;

export function splitJson(json: string, partChars = TEMPLATE_PART_CHARS): string[] {
  const parts: string[] = [];
  for (let i = 0; i < json.length; i += partChars) parts.push(json.slice(i, i + partChars));
  return parts.length > 0 ? parts : [""];
}

export async function loadTemplateJson(ctx: DbCtx, template: Doc<"templates">): Promise<string> {
  const rows = await ctx.db
    .query("templateDesigns")
    .withIndex("by_template_part", (q) => q.eq("templateId", template._id))
    .collect();
  if (rows.length !== template.parts) throw errors.notFound("Template content");
  return rows
    .sort((a, b) => a.part - b.part)
    .map((r) => r.json)
    .join("");
}

export async function loadTemplateDesign(
  ctx: DbCtx,
  templateId: Id<"templates">,
): Promise<{
  template: Doc<"templates">;
  design: Design;
}> {
  const template = await ctx.db.get("templates", templateId);
  if (template?.status !== "published") throw errors.notFound("Template");
  return { template, design: JSON.parse(await loadTemplateJson(ctx, template)) as Design };
}

/**
 * Copy a design with a fresh design id and fresh node / animation ids (page links remapped). Asset refs keep
 * their ids: they point at shared library assets (or the caller's workspace assets).
 */
export function copyWithFreshIds(
  source: Design,
  opts: { name?: string; templateId?: string } = {},
): Design {
  const map = new Map<DocId, DocId>([[ROOT_ID, ROOT_ID]]);
  for (const id of Object.keys(source.nodes)) if (id !== ROOT_ID) map.set(id, newId());
  const remap = (id: DocId) => map.get(id) ?? id;
  const nodes: Record<DocId, Node> = {};
  for (const node of Object.values(source.nodes)) {
    const copy = clone(node) as Node & { children?: DocId[]; anim?: { id: DocId }[] };
    copy.id = remap(node.id);
    if (copy.parent !== null) copy.parent = remap(copy.parent);
    if (copy.children) copy.children = copy.children.map(remap);
    if (copy.anim) copy.anim = copy.anim.map((a) => ({ ...a, id: newId() }));
    if (typeof copy.link === "string" && copy.link.startsWith("page:")) {
      copy.link = `page:${remap(copy.link.slice(5))}`;
    }
    nodes[copy.id] = copy;
  }
  const now = Date.now();
  const meta: Design["meta"] = { ...clone(source.meta ?? {}), createdAt: now, updatedAt: now };
  if (opts.templateId) meta.templateId = opts.templateId;
  return {
    ...clone(source),
    id: newId(),
    name: opts.name ?? source.name,
    nodes,
    meta,
  };
}
