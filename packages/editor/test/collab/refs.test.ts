import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The editor references Convex functions by name (no generated API). This checks every name used by the
 * collaboration, export and present code against the Convex sources, so a rename on the server fails here.
 */
// Vitest runs from packages/editor.
const root = `${resolve(process.cwd(), "../..")}/`;
const files = ["packages/editor/src/collab/backend.ts", "packages/editor/src/export/backend.ts"];

function referenced(): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const src = readFileSync(`${root}${f}`, "utf8");
    for (const m of src.matchAll(/"([a-z][A-Za-z_/]+):([A-Za-z_]+)"/g)) out.add(`${m[1]}:${m[2]}`);
  }
  return [...out].sort();
}

function exportsOf(modulePath: string): Set<string> {
  const src = readFileSync(`${root}convex/${modulePath}.ts`, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/export const (\w+)\s*=/g)) names.add(m[1] as string);
  for (const m of src.matchAll(/export \{([^}]+)\}/g)) {
    for (const part of (m[1] as string).split(",")) {
      const alias = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (alias) names.add(alias);
    }
  }
  return names;
}

describe("Convex function references", () => {
  const refs = referenced();
  test("are found in the sources", () => {
    expect(refs.length).toBeGreaterThan(20);
  });
  test.each(refs)("%s exists", (ref) => {
    const [mod, fn] = ref.split(":") as [string, string];
    expect(exportsOf(mod).has(fn)).toBe(true);
  });
});
