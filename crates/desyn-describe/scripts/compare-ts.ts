// Compares the TypeScript approximation (`describeDesign` of @desyn/ai, used by MemoryHost) with the Rust engine
// output on every fixture. Prints per fixture: issue codes only one side reports, groups / semantic labels, and
// palette / typography differences. Informational (no exit code).
//
//   cargo run --example describe -- crates/desyn-describe/tests/fixtures/<name>.json --json > /tmp/rust.json
//   packages/schema/node_modules/.bin/tsx crates/desyn-describe/scripts/compare-ts.ts <fixtures dir> <rust json dir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeDesign } from "../../../packages/ai/src/design/describe.ts";

const [fixturesDir, rustDir] = process.argv.slice(2);
if (!fixturesDir || !rustDir) throw new Error("usage: compare-ts.ts <fixtures dir> <rust json dir>");

for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort()) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
  const rust = JSON.parse(readFileSync(join(rustDir, file), "utf8"));
  const ts = describeDesign(fixture.design, {});
  const key = (i: { code: string; ids: string[] }) => `${i.code} ${i.ids.join(",")}`;
  const tsIssues = new Set(ts.issues.map(key));
  const rustIssues = new Set(rust.issues.map(key));
  const onlyTs = [...tsIssues].filter((k) => !rustIssues.has(k));
  const onlyRust = [...rustIssues].filter((k) => !tsIssues.has(k));
  console.log(`\n## ${file}`);
  console.log(`issues: ts ${ts.issues.length}, rust ${rust.issues.length}`);
  for (const k of onlyTs) console.log(`  only ts:   ${k}`);
  for (const k of onlyRust) console.log(`  only rust: ${k}`);
  const sem = (nodes: { id: string; semantic?: string; children?: unknown[] }[], out: string[] = []) => {
    for (const n of nodes) {
      if (n.semantic) out.push(`${n.id}=${n.semantic}`);
      if (n.children) sem(n.children as typeof nodes, out);
    }
    return out;
  };
  console.log(`semantic ts:   ${sem(ts.tree).join(" | ")}`);
  console.log(`semantic rust: ${sem(rust.tree).join(" | ")}`);
  console.log(`palette ts:   ${ts.palette.map((p) => `${p.color} ${p.share}`).join(", ")}`);
  console.log(`palette rust: ${rust.palette.map((p: { color: string; share: number }) => `${p.color} ${p.share}`).join(", ")}`);
  console.log(`typography ts: ${JSON.stringify(ts.typography)} rust: ${JSON.stringify(rust.typography)}`);
}
