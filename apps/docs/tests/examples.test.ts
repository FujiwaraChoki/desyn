import { readFileSync } from "node:fs";
import { validateDesign, validateNode } from "@desyn/schema";
import { describe, expect, it } from "vitest";
import { contentPath } from "../src/lib/content.ts";

/** JSON code blocks of a page, in order. */
function jsonBlocks(slug: string): unknown[] {
  const source = readFileSync(contentPath(slug), "utf8");
  return [...source.matchAll(/```json(?: title="[^"]*")?\n([\s\S]*?)```/g)].map((m) =>
    JSON.parse(m[1] ?? ""),
  );
}

describe("examples in the docs are valid against @desyn/schema", () => {
  it("the document model example is a valid Design", () => {
    const design = jsonBlocks("developers/document-model").find(
      (b): b is { schema: number } => typeof b === "object" && b !== null && "schema" in b,
    );
    const result = validateDesign(design);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("nodes created in the operations examples are valid nodes", () => {
    const blocks = jsonBlocks("developers/operations");
    const create = blocks.find(
      (b): b is { op: string; nodes: unknown[] } =>
        typeof b === "object" && b !== null && (b as { op?: string }).op === "create",
    );
    expect(create?.nodes.length).toBe(2);
    for (const node of create?.nodes ?? []) expect(validateNode(node)).toEqual([]);
  });

  it("every JSON block in the developer pages parses", () => {
    for (const slug of [
      "developers/document-model",
      "developers/operations",
      "developers/describe",
      "developers/render-worker",
      "developers/api",
      "developers/mcp",
    ]) {
      expect(() => jsonBlocks(slug), slug).not.toThrow();
    }
  });
});
