import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { z } from "zod";
import * as S from "../src";
import { canonicalize } from "../src";
import { jsonSchemaDocuments } from "../src/json-schema";

const root = resolve(__dirname, "../../..");
const nodesDir = join(root, "spec/fixtures/nodes");
const samples = readdirSync(nodesDir)
  .filter((f) => f.endsWith(".json"))
  .map(
    (f) =>
      JSON.parse(readFileSync(join(nodesDir, f), "utf8")) as {
        name: string;
        schema: string;
        valid: boolean;
        value: unknown;
      },
  );

const schemas = S as unknown as Record<string, z.ZodType>;

describe("node / paint fixtures", () => {
  test("cover every node, fill and effect type", () => {
    const valid = samples.filter((s) => s.valid);
    for (const t of S.NODE_TYPES) expect(valid.some((s) => s.name === `node-${t}`)).toBe(true);
    for (const t of S.FILL_TYPES)
      expect(
        valid.some((s) => s.schema === "Fill" && (s.value as { type: string }).type === t),
      ).toBe(true);
    for (const t of S.EFFECT_TYPES)
      expect(
        valid.some((s) => s.schema === "Effect" && (s.value as { type: string }).type === t),
      ).toBe(true);
    expect(samples.filter((s) => !s.valid).length).toBeGreaterThanOrEqual(10);
  });

  test.each(samples.map((s) => [s.name, s] as const))("%s", (_n, s) => {
    const schema = schemas[`${s.schema}Schema`];
    expect(schema, s.schema).toBeDefined();
    const parsed = (schema as z.ZodType).safeParse(s.value);
    expect(parsed.success).toBe(s.valid);
    if (s.valid) {
      // Loose objects: parsing preserves every key.
      expect(canonicalize(parsed.data)).toBe(canonicalize(s.value));
      if (s.schema.endsWith("Node")) expect(S.validateNode(s.value)).toEqual([]);
    }
  });
});

describe("zod schemas", () => {
  test("unknown keys survive parsing at every level", () => {
    const rect = { ...S.createRect({ id: "abcdefabcdef" }), future: { a: 1 } };
    rect.fills = [{ type: "solid", color: "#ffffff", futureFill: true } as never];
    const out = S.RectNodeSchema.parse(rect) as Record<string, unknown>;
    expect(out.future).toEqual({ a: 1 });
    expect((out.fills as Record<string, unknown>[])[0]?.futureFill).toBe(true);
  });

  test("numbers must be finite", () => {
    const rect = S.createRect({ id: "abcdefabcdef", rotation: Number.POSITIVE_INFINITY });
    expect(S.RectNodeSchema.safeParse(rect).success).toBe(false);
    expect(S.RectNodeSchema.safeParse({ ...rect, rotation: Number.NaN }).success).toBe(false);
  });

  test('records validate an own "__proto__" entry (zod alone skips it)', () => {
    const styles = S.emptyStyles();
    const parse = (json: string) => JSON.parse(json) as Record<string, never>;
    expect(
      S.DesignStylesSchema.safeParse({ ...styles, variables: parse('{"__proto__":{"a":1}}') })
        .success,
    ).toBe(false);
    expect(
      S.DesignStylesSchema.safeParse({ ...styles, variables: parse('{"__proto__":"ok"}') }).success,
    ).toBe(true);
    // Not an Id key.
    const color = '{"__proto__":{"name":"x","value":"#000000"}}';
    expect(S.DesignStylesSchema.safeParse({ ...styles, colors: parse(color) }).success).toBe(false);
    const text = S.createText({ id: "abcdefabcdef" });
    const bad = { ...text, style: { ...text.style, variations: parse('{"__proto__":"wide"}') } };
    expect(S.TextNodeSchema.safeParse(bad).success).toBe(false);
    const svg = S.createSvg({ id: "abcdefabcdef", markup: "<svg/>" });
    expect(
      S.SvgNodeSchema.safeParse({ ...svg, recolor: parse('{"__proto__":"#000000"}') }).success,
    ).toBe(false);
    // Unknown "__proto__" members of loose objects stay allowed (forward compatibility).
    expect(
      S.RectNodeSchema.safeParse({ ...S.createRect(), ...parse('{"__proto__":1}') }).success,
    ).toBe(true);
  });

  test("nodeSchemaFor", () => {
    expect(S.nodeSchemaFor("rect")).toBe(S.RectNodeSchema);
    expect(S.nodeSchemaFor("toString")).toBeUndefined();
    expect(S.nodeSchemaFor(5)).toBeUndefined();
  });

  test("validateNode flags children on leaf nodes and unknown types", () => {
    const rect = { ...S.createRect({ id: "abcdefabcdef" }), children: [] };
    expect(S.validateNode(rect).map((i) => i.code)).toContain("non-container-children");
    expect(S.validateNode({ type: "blob" })[0]?.code).toBe("unknown-type");
    expect(S.validateNode(null)[0]?.code).toBe("shape");
    expect(S.isValidNode(S.createRect())).toBe(true);
  });

  test("ops and transactions", () => {
    const tx = {
      id: "abcdefabcdef",
      label: "x",
      source: "ai",
      ts: 1,
      ops: [
        { op: "create", nodes: [S.createRect()], parent: "root", index: 0 },
        { op: "update", id: "root", set: { name: "x" }, unset: ["alt"] },
        { op: "patch", id: "abcdefabcdef", path: ["fills", 0], value: null },
        { op: "delete", id: "abcdefabcdef" },
        { op: "move", id: "abcdefabcdef", parent: "root" },
        { op: "asset", remove: ["abcdefabcdef"] },
        { op: "styles", path: [], value: {} },
        { op: "doc", set: {}, unset: ["brandKitId"] },
      ],
    };
    expect(S.TransactionSchema.safeParse(tx).success).toBe(true);
    expect(S.OpSchema.safeParse({ op: "move", id: "x", parent: "root", index: 1.5 }).success).toBe(
      false,
    );
    expect(S.OpSchema.safeParse({ op: "doc", set: {}, unset: ["name"] }).success).toBe(false);
  });
});

describe("JSON Schema", () => {
  test("committed files match the zod schemas", () => {
    const dir = join(root, "packages/schema/json-schema");
    const docs = jsonSchemaDocuments();
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(
      Object.keys(docs)
        .map((n) => `${n}.json`)
        .sort(),
    );
    for (const [name, doc] of Object.entries(docs)) {
      const committed = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
      expect(
        committed,
        `${name}.json is stale: run pnpm --filter @desyn/schema gen:json-schema`,
      ).toEqual(doc);
    }
  });

  test("documents carry ids and shared defs", () => {
    const docs = jsonSchemaDocuments();
    expect(docs.Design?.$id).toBe("https://desyn.app/schema/v1/Design.json");
    const node = docs.Node as { anyOf: { $ref: string }[] };
    expect(node.anyOf).toHaveLength(19);
    expect(node.anyOf[0]?.$ref).toBe("#/$defs/RootNode");
  });
});
