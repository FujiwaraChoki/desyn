import { cloneSubtree, pages } from "@desyn/doc-ops";
import {
  type AssetRef,
  type Design,
  DesignSchema,
  type Fill,
  type Id,
  type Node,
  type Op,
  ROOT_ID,
} from "@desyn/schema";

/**
 * Bringing template pages into the open design: the template's page subtrees are copied with fresh ids, the
 * assets they reference (template library keys) are added, and named styles / variables the copy uses but
 * the design lacks are added too. "replace" swaps the current page for the template page in one step; "add"
 * inserts after it.
 */

export type TemplateApplyMode = "replace" | "add";

/** Parses template JSON from `templates.getDesign` (loose schema, so unknown keys survive). */
export function parseTemplateDesign(json: string): Design {
  const parsed = DesignSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error("The template could not be read.");
  return parsed.data as Design;
}

function assetIdsOf(node: Node, out: Set<Id>): void {
  const n = node as Node & {
    assetId?: Id;
    maskAssetId?: Id;
    posterAssetId?: Id;
    fills?: Fill[];
    background?: Fill[];
    strokes?: { fills?: Fill[] }[];
  };
  if (n.assetId) out.add(n.assetId);
  if (n.maskAssetId) out.add(n.maskAssetId);
  if (n.posterAssetId) out.add(n.posterAssetId);
  const fills = [...(n.fills ?? []), ...(n.background ?? [])];
  for (const s of n.strokes ?? []) fills.push(...(s.fills ?? []));
  for (const f of fills) if (f.type === "image" && f.assetId) out.add(f.assetId);
}

/** Every `$style` / `$var` reference inside a value. */
function refsOf(value: unknown, styles: Set<string>, vars: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) refsOf(v, styles, vars);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.$style === "string") styles.add(obj.$style);
  if (typeof obj.$var === "string") vars.add(obj.$var);
  for (const v of Object.values(obj)) refsOf(v, styles, vars);
}

export interface TemplateImport {
  ops: Op[];
  /** New page ids, in order. */
  pageIds: Id[];
}

/**
 * Ops copying `templatePageIds` (default: every page of the template) into `design`.
 * `mode: "replace"` puts them where `currentPageId` is and deletes it; "add" inserts after it.
 */
export function templateImportOps(
  design: Design,
  template: Design,
  options: { mode: TemplateApplyMode; currentPageId: Id | null; templatePageIds?: Id[] },
): TemplateImport {
  const sourcePages = pages(template)
    .map((p) => p.id)
    .filter((id) => !options.templatePageIds || options.templatePageIds.includes(id));
  if (sourcePages.length === 0) throw new Error("The template has no pages.");
  const current = pages(design).map((p) => p.id);
  const at = options.currentPageId ? current.indexOf(options.currentPageId) : -1;
  const insertAt = options.mode === "replace" && at >= 0 ? at : at >= 0 ? at + 1 : current.length;

  const ops: Op[] = [];
  const pageIds: Id[] = [];
  const assetIds = new Set<Id>();
  const styleIds = new Set<string>();
  const varNames = new Set<string>();

  sourcePages.forEach((pageId, k) => {
    const { op } = cloneSubtree(template, pageId, { parent: ROOT_ID, index: insertAt + k });
    for (const n of op.nodes) {
      assetIdsOf(n, assetIds);
      refsOf(n, styleIds, varNames);
    }
    pageIds.push(op.nodes[0]?.id as Id);
    ops.push(op);
  });

  // Assets the copy needs (template library keys are signed for every design; urls never persist).
  const assets: Record<Id, AssetRef> = {};
  for (const id of assetIds) {
    const ref = template.assets[id];
    if (!ref || design.assets[id]) continue;
    const { url: _url, ...rest } = ref;
    assets[id] = rest;
  }
  const head: Op[] = [];
  if (Object.keys(assets).length > 0) head.push({ op: "asset", set: assets });

  // Styles and variables the copy references and the design lacks.
  for (const id of styleIds) {
    for (const kind of ["colors", "text", "effects"] as const) {
      const entry = template.styles[kind][id];
      if (entry && !design.styles[kind][id]) {
        head.push({ op: "styles", path: [kind, id], value: entry });
      }
    }
  }
  for (const name of varNames) {
    const value = template.styles.variables[name];
    if (value !== undefined && design.styles.variables[name] === undefined) {
      head.push({ op: "styles", path: ["variables", name], value });
    }
  }

  const tail: Op[] =
    options.mode === "replace" && options.currentPageId && at >= 0
      ? [{ op: "delete", id: options.currentPageId }]
      : [];
  return { ops: [...head, ...ops, ...tail], pageIds };
}
