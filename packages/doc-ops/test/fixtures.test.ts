// Conformance runner over spec/fixtures (the same files the Rust core runs).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as schema from "@desyn/schema";
import { canonicalize, type Design, type Transaction, validateDesign } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import { applyOps, applyTransaction } from "../src";
import { deepFreeze } from "./helpers";

const root = resolve(__dirname, "../../../spec/fixtures");

function load<T>(dir: string): T[] {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(root, dir, f), "utf8")) as T);
}

interface OpsFixture {
  name: string;
  description: string;
  layoutSensitive: boolean;
  before: Design;
  tx: Transaction;
  after: Design;
  applied: unknown[];
  dropped: { index: number; reason: string }[];
  inverse: Transaction;
}

const ops = load<OpsFixture>("ops");

describe("ops fixtures", () => {
  test("coverage", () => {
    expect(ops.length).toBeGreaterThanOrEqual(120);
    const kinds = new Set(ops.flatMap((f) => f.tx.ops.map((o) => (o as { op?: string })?.op)));
    for (const k of schema.OP_KINDS) expect(kinds.has(k)).toBe(true);
    const reasons = new Set(ops.flatMap((f) => f.dropped.map((d) => d.reason)));
    for (const r of schema.DROP_REASONS) expect(reasons.has(r), r).toBe(true);
    expect(ops.every((f) => f.layoutSensitive === false)).toBe(true);
  });

  test.each(ops.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    const before = deepFreeze(structuredClone(f.before));
    const result = applyTransaction(before, f.tx);
    expect(canonicalize(result.dropped)).toBe(canonicalize(f.dropped));
    expect(canonicalize(result.applied)).toBe(canonicalize(f.applied));
    expect(canonicalize(result.design)).toBe(canonicalize(f.after));
    expect(validateDesign(result.design).ok).toBe(true);

    expect(canonicalize(result.inverse)).toBe(canonicalize(f.inverse));
    const undo = applyTransaction(result.design, result.inverse);
    expect(undo.dropped).toEqual([]);
    expect(canonicalize(undo.design)).toBe(canonicalize(f.before));

    const replay = applyOps(before, f.applied);
    expect(replay.dropped).toEqual([]);
    expect(canonicalize(replay.design)).toBe(canonicalize(f.after));
  });
});

interface Sample {
  name: string;
  schema: string;
  valid: boolean;
  value: unknown;
}

describe("node fixtures", () => {
  const samples = load<Sample>("nodes");
  const schemas = schema as unknown as Record<
    string,
    { safeParse(v: unknown): { success: boolean } }
  >;
  test.each(samples.map((s) => [s.name, s] as const))("%s", (_n, s) => {
    expect(schemas[`${s.schema}Schema`]?.safeParse(s.value).success).toBe(s.valid);
    if (s.valid && s.schema === "Design") expect(validateDesign(s.value).ok).toBe(true);
    if (
      s.valid &&
      s.schema.endsWith("Node") &&
      s.schema !== "RootNode" &&
      s.schema !== "PageNode"
    ) {
      // Every valid node can be created on a page and deleted again.
      const d = schema.createDesign("custom", "instagram-post", {
        pageId: "page00000001",
        id: "dsn000000001",
        now: 0,
      });
      const node = { ...(s.value as Record<string, unknown>), children: undefined } as Record<
        string,
        unknown
      >;
      if (!schema.isContainerType(String(node.type))) delete node.children;
      else node.children = [];
      const r = applyOps(d, [{ op: "create", nodes: [node as never], parent: "page00000001" }]);
      expect(r.dropped).toEqual([]);
    }
  });
});
