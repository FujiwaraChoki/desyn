// Full design validation: zod shape of every part plus the structural invariants of DOCUMENT_MODEL §4.
import { z } from "zod";
import { isContainerType, ROOT_ID } from "./constants";
import type { Design } from "./types";
import {
  AssetRefSchema,
  DesignKindSchema,
  DesignMetaSchema,
  DesignStylesSchema,
  IdSchema,
  nodeSchemaFor,
} from "./zod";

export type ValidationPath = (string | number)[];

export interface ValidationIssue {
  path: ValidationPath;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  /** Non-fatal findings (dangling asset or style references). */
  warnings: ValidationIssue[];
}

const DesignEnvelopeSchema = z.looseObject({
  schema: z.literal(1),
  id: IdSchema,
  name: z.string(),
  kind: DesignKindSchema,
  nodes: z.record(z.string(), z.unknown()),
  assets: z.record(z.string(), z.unknown()),
  styles: DesignStylesSchema,
  brandKitId: z.string().optional(),
  meta: DesignMetaSchema,
});

function zodIssues(error: z.ZodError, prefix: ValidationPath): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: [...prefix, ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))],
    code: "shape",
    message: i.message,
  }));
}

/**
 * Validates one node in isolation: its zod schema (by `type`) and the per-node invariants (a node that is not a
 * container must not carry `children`). Structural checks that need the whole design live in validateDesign.
 */
export function validateNode(node: unknown, path: ValidationPath = []): ValidationIssue[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return [{ path, code: "shape", message: "node must be an object" }];
  }
  const type = (node as { type?: unknown }).type;
  const schema = nodeSchemaFor(type);
  if (!schema) {
    return [
      {
        path: [...path, "type"],
        code: "unknown-type",
        message: `unknown node type ${JSON.stringify(type)}`,
      },
    ];
  }
  const issues: ValidationIssue[] = [];
  const parsed = schema.safeParse(node);
  if (!parsed.success) issues.push(...zodIssues(parsed.error, path));
  if (!isContainerType(type as string) && Object.hasOwn(node, "children")) {
    issues.push({
      path: [...path, "children"],
      code: "non-container-children",
      message: `a ${String(type)} node cannot have children`,
    });
  }
  return issues;
}

/** True when `validateNode` reports nothing. */
export function isValidNode(node: unknown): boolean {
  return validateNode(node).length === 0;
}

export function validateDesign(design: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const envelope = DesignEnvelopeSchema.safeParse(design);
  if (!envelope.success) {
    errors.push(...zodIssues(envelope.error, []));
    // Structural checks need a node map; bail out when it is unusable.
    const nodes = (design as { nodes?: unknown } | null)?.nodes;
    if (typeof nodes !== "object" || nodes === null) return { ok: false, errors, warnings };
  }
  const d = design as Design;

  // Assets
  for (const [key, asset] of Object.entries(d.assets ?? {})) {
    const parsed = AssetRefSchema.safeParse(asset);
    if (!parsed.success) errors.push(...zodIssues(parsed.error, ["assets", key]));
    else if (parsed.data.id !== key) {
      errors.push({
        path: ["assets", key, "id"],
        code: "key-mismatch",
        message: `asset key "${key}" != id`,
      });
    }
  }

  // Nodes: shape
  const nodes = d.nodes as unknown as Record<string, Record<string, unknown>>;
  for (const [key, node] of Object.entries(nodes)) {
    errors.push(...validateNode(node, ["nodes", key]));
    if (node && typeof node === "object" && node.id !== key) {
      errors.push({
        path: ["nodes", key, "id"],
        code: "key-mismatch",
        message: `node key "${key}" != id`,
      });
    }
  }

  // Invariant 1: root
  const root = nodes[ROOT_ID];
  if (!root) {
    errors.push({
      path: ["nodes", ROOT_ID],
      code: "missing-root",
      message: "nodes.root is missing",
    });
    return { ok: false, errors, warnings };
  }
  if (root.type !== "root") {
    errors.push({
      path: ["nodes", ROOT_ID, "type"],
      code: "root-type",
      message: "nodes.root must have type root",
    });
  }
  if (root.parent !== null) {
    errors.push({
      path: ["nodes", ROOT_ID, "parent"],
      code: "root-parent",
      message: "root.parent must be null",
    });
  }

  // Invariants 1-2: parent/children agreement, page nesting
  for (const [key, node] of Object.entries(nodes)) {
    if (!node || typeof node !== "object") continue;
    const children = node.children;
    if (Array.isArray(children)) {
      const seen = new Set<string>();
      children.forEach((childId, i) => {
        const path = ["nodes", key, "children", i];
        if (typeof childId !== "string") return;
        if (seen.has(childId)) {
          errors.push({
            path,
            code: "duplicate-child",
            message: `"${childId}" appears twice in children`,
          });
        }
        seen.add(childId);
        const child = nodes[childId];
        if (!child) {
          errors.push({
            path,
            code: "missing-child",
            message: `child "${childId}" does not exist`,
          });
          return;
        }
        if (child.parent !== key) {
          errors.push({
            path,
            code: "child-parent-mismatch",
            message: `child "${childId}" has parent ${JSON.stringify(child.parent)}, expected "${key}"`,
          });
        }
        if (key === ROOT_ID && child.type !== "page") {
          errors.push({
            path,
            code: "page-nesting",
            message: `root child "${childId}" must be a page`,
          });
        }
        if (key !== ROOT_ID && child.type === "page") {
          errors.push({
            path,
            code: "page-nesting",
            message: `page "${childId}" must be a child of root`,
          });
        }
      });
    }
    if (key === ROOT_ID) continue;
    const parentId = node.parent;
    if (typeof parentId !== "string") {
      errors.push({
        path: ["nodes", key, "parent"],
        code: "missing-parent",
        message: "non-root node needs a parent",
      });
      continue;
    }
    const parent = nodes[parentId];
    if (!parent) {
      errors.push({
        path: ["nodes", key, "parent"],
        code: "missing-parent",
        message: `parent "${parentId}" does not exist`,
      });
      continue;
    }
    if (!isContainerType(String(parent.type))) {
      errors.push({
        path: ["nodes", key, "parent"],
        code: "parent-not-container",
        message: `parent "${parentId}" (${String(parent.type)}) cannot have children`,
      });
      continue;
    }
    const siblings = parent.children;
    if (!Array.isArray(siblings) || !siblings.includes(key)) {
      errors.push({
        path: ["nodes", key, "parent"],
        code: "not-in-parent-children",
        message: `node is missing from "${parentId}".children`,
      });
    }
  }

  // Invariant 2: no cycles, everything reachable from root
  const reached = new Set<string>([ROOT_ID]);
  const stack = [ROOT_ID];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const children = nodes[id]?.children;
    if (!Array.isArray(children)) continue;
    for (const c of children) {
      if (typeof c !== "string" || !nodes[c] || nodes[c].parent !== id) continue;
      if (reached.has(c)) {
        errors.push({
          path: ["nodes", c],
          code: "cycle",
          message: `"${c}" is reachable twice (cycle)`,
        });
        continue;
      }
      reached.add(c);
      stack.push(c);
    }
  }
  for (const key of Object.keys(nodes)) {
    if (!reached.has(key)) {
      errors.push({
        path: ["nodes", key],
        code: "unreachable",
        message: `"${key}" is not reachable from root`,
      });
    }
  }

  // Dangling references (warnings)
  const assets = d.assets ?? {};
  const colorStyles = d.styles?.colors ?? {};
  const textStyles = d.styles?.text ?? {};
  for (const [key, node] of Object.entries(nodes)) {
    if (!node || typeof node !== "object") continue;
    for (const field of ["assetId", "maskAssetId", "posterAssetId"] as const) {
      const ref = node[field];
      if (typeof ref === "string" && !Object.hasOwn(assets, ref)) {
        warnings.push({
          path: ["nodes", key, field],
          code: "dangling-asset",
          message: `asset "${ref}" not in design.assets`,
        });
      }
    }
    const styleRef = node.styleRef;
    if (typeof styleRef === "string" && !Object.hasOwn(textStyles, styleRef)) {
      warnings.push({
        path: ["nodes", key, "styleRef"],
        code: "dangling-style",
        message: `text style "${styleRef}" missing`,
      });
    }
    walkRefs(node, ["nodes", key], (path, ref) => {
      if (
        "$style" in ref &&
        typeof ref.$style === "string" &&
        !Object.hasOwn(colorStyles, ref.$style)
      ) {
        warnings.push({
          path,
          code: "dangling-style",
          message: `color style "${ref.$style}" missing`,
        });
      }
      if (
        "$var" in ref &&
        typeof ref.$var === "string" &&
        !Object.hasOwn(d.styles?.variables ?? {}, ref.$var)
      ) {
        warnings.push({
          path,
          code: "dangling-variable",
          message: `variable "${ref.$var}" missing`,
        });
      }
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

function walkRefs(
  value: unknown,
  path: ValidationPath,
  visit: (path: ValidationPath, ref: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walkRefs(v, [...path, i], visit);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const rec = value as Record<string, unknown>;
  if ("$var" in rec || "$style" in rec) {
    visit(path, rec);
    return;
  }
  for (const [k, v] of Object.entries(rec)) walkRefs(v, [...path, k], visit);
}

/** Throws with a readable summary when the design is invalid. */
export function assertValidDesign(design: unknown): asserts design is Design {
  const result = validateDesign(design);
  if (!result.ok) {
    const lines = result.errors
      .slice(0, 10)
      .map((e) => `${e.path.join(".")}: ${e.message} [${e.code}]`);
    throw new Error(`invalid design (${result.errors.length} errors)\n${lines.join("\n")}`);
  }
}
