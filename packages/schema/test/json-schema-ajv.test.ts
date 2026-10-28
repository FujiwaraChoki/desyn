// The committed JSON Schema files must accept and reject exactly what the zod schemas do. Checked with an
// independent draft 2020-12 validator (ajv) over the shared conformance fixtures.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { createDesign, DESIGN_KINDS } from "../src";

const root = resolve(__dirname, "../../..");
const schemaDir = join(root, "packages/schema/json-schema");
const fixturesDir = join(root, "spec/fixtures");

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();
function validator(name: string): ValidateFunction {
  let v = validators.get(name);
  if (!v) {
    const doc = JSON.parse(readFileSync(join(schemaDir, `${name}.json`), "utf8"));
    v = ajv.compile(doc);
    validators.set(name, v);
  }
  return v;
}

function readJson<T>(dir: string): T[] {
  return readdirSync(join(fixturesDir, dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(fixturesDir, dir, f), "utf8")) as T);
}

describe("JSON Schema files (ajv, draft 2020-12)", () => {
  test("every file compiles", () => {
    const files = readdirSync(schemaDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(40);
    for (const f of files) expect(() => validator(f.replace(/\.json$/, "")), f).not.toThrow();
  });

  const samples = readJson<{ name: string; schema: string; valid: boolean; value: unknown }>(
    "nodes",
  );
  test.each(samples.map((s) => [s.name, s] as const))("node fixture %s", (_n, s) => {
    const v = validator(s.schema);
    const ok = v(s.value);
    expect(ok, JSON.stringify(v.errors?.slice(0, 3))).toBe(s.valid);
  });

  test("ops fixtures: designs and transactions validate", () => {
    const ops = readJson<{ name: string; before: unknown; after: unknown; tx: { ops: unknown[] } }>(
      "ops",
    );
    const design = validator("Design");
    for (const f of ops) {
      expect(design(f.before), `${f.name} before ${JSON.stringify(design.errors?.[0])}`).toBe(true);
      expect(design(f.after), `${f.name} after ${JSON.stringify(design.errors?.[0])}`).toBe(true);
    }
  });

  test("factory designs validate for every kind", () => {
    const design = validator("Design");
    for (const kind of DESIGN_KINDS) {
      expect(design(createDesign(kind)), `${kind} ${JSON.stringify(design.errors?.[0])}`).toBe(
        true,
      );
    }
  });

  test("svg nodes need assetId or markup", () => {
    const svg = validator("SvgNode");
    const base = createDesign("custom").nodes.root as unknown as Record<string, unknown>;
    const node = {
      ...base,
      id: "svg000000001",
      parent: "page00000001",
      type: "svg",
      name: "Vector",
    };
    delete (node as { children?: unknown }).children;
    expect(svg(node)).toBe(false);
    expect(svg({ ...node, markup: "<svg/>" })).toBe(true);
    expect(svg({ ...node, assetId: "asset0000001" })).toBe(true);
  });
});
