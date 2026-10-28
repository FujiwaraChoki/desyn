// Generates spec/fixtures/{ops,nodes,canonical}/*.json from the hand-written cases, after verifying the TS
// implementation against every hand-computed expectation. Run: pnpm --filter @desyn/doc-ops gen:fixtures
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@desyn/schema";
import { canonicalize, type Transaction, validateDesign } from "@desyn/schema";
import { applyOps, applyTransaction } from "../src/apply";
import { baseDesign } from "./fixture-base";
import { CASES, type Case } from "./fixture-cases";
import { CANONICAL_CASES, SAMPLES } from "./fixture-samples";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../spec/fixtures");
const TS = 1760000000000;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const failures: string[] = [];

function check(cond: boolean, message: string) {
  if (!cond) failures.push(message);
}

function resetDir(dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith(".json")) rmSync(join(dir, f));
}

function write(dir: string, name: string, value: unknown) {
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function buildOpsFixture(c: Case, n: number) {
  const before = clone(c.before ?? baseDesign());
  const tx: Transaction = {
    id: `tx${String(n).padStart(10, "0")}`,
    label: c.name,
    ops: clone(c.ops) as Transaction["ops"],
    source: "user",
    ts: TS,
  };
  const dropped = c.dropped ?? [];
  const droppedIdx = new Set(dropped.map((d) => d.index));
  const expectedApplied = c.applied ?? c.ops.filter((_, i) => !droppedIdx.has(i));
  const expectedAfter = clone(before);
  c.after?.(expectedAfter);

  const snapshot = canonicalize(before);
  const result = applyTransaction(before, tx);
  const tag = `[${c.name}]`;
  check(canonicalize(before) === snapshot, `${tag} input design was mutated`);
  check(
    canonicalize(result.dropped) === canonicalize(dropped),
    `${tag} dropped ${canonicalize(result.dropped)} != expected ${canonicalize(dropped)}`,
  );
  check(
    canonicalize(result.applied) === canonicalize(expectedApplied),
    `${tag} applied differs:\n  got      ${canonicalize(result.applied)}\n  expected ${canonicalize(expectedApplied)}`,
  );
  check(
    canonicalize(result.design) === canonicalize(expectedAfter),
    `${tag} after differs:\n  got      ${canonicalize(result.design)}\n  expected ${canonicalize(expectedAfter)}`,
  );
  const undo = applyTransaction(result.design, result.inverse);
  check(undo.dropped.length === 0, `${tag} inverse dropped ops ${canonicalize(undo.dropped)}`);
  check(canonicalize(undo.design) === snapshot, `${tag} inverse does not restore before`);
  const replay = applyOps(before, result.applied);
  check(replay.dropped.length === 0, `${tag} replaying applied drops ops`);
  check(
    canonicalize(replay.design) === canonicalize(result.design),
    `${tag} replaying applied differs from after`,
  );
  const vb = validateDesign(before);
  const va = validateDesign(expectedAfter);
  check(vb.ok, `${tag} before invalid: ${JSON.stringify(vb.errors.slice(0, 3))}`);
  check(va.ok, `${tag} after invalid: ${JSON.stringify(va.errors.slice(0, 3))}`);

  return {
    name: c.name,
    description: c.description,
    layoutSensitive: false,
    before,
    tx,
    after: expectedAfter,
    applied: expectedApplied,
    dropped,
    // Pinned from the TS applier after the replay checks above (README "Inverse transaction").
    inverse: result.inverse,
  };
}

function main() {
  const names = new Set<string>();
  for (const c of CASES) {
    if (names.has(c.name)) failures.push(`duplicate case name ${c.name}`);
    names.add(c.name);
  }

  const opsDir = join(OUT, "ops");
  const opsFixtures = CASES.map((c, i) => buildOpsFixture(c, i + 1));

  const schemas = schema as unknown as Record<
    string,
    { safeParse?: (v: unknown) => { success: boolean } }
  >;
  for (const s of SAMPLES) {
    const z = schemas[`${s.schema}Schema`];
    if (!z?.safeParse) {
      failures.push(`[${s.name}] unknown schema ${s.schema}`);
      continue;
    }
    check(z.safeParse(s.value).success === s.valid, `[${s.name}] expected valid=${s.valid}`);
  }

  for (const c of CANONICAL_CASES) {
    const got = canonicalize(JSON.parse(c.inputText));
    check(got === c.canonical, `[canonical ${c.name}] got ${got} expected ${c.canonical}`);
  }

  if (failures.length > 0) {
    console.error(`${failures.length} fixture expectation(s) failed:\n${failures.join("\n")}`);
    process.exit(1);
  }

  resetDir(opsDir);
  for (const f of opsFixtures) write(opsDir, f.name, f);
  const nodesDir = join(OUT, "nodes");
  resetDir(nodesDir);
  for (const s of SAMPLES) write(nodesDir, s.name, s);
  const canonDir = join(OUT, "canonical");
  resetDir(canonDir);
  for (const c of CANONICAL_CASES) {
    // `input` embeds the raw text verbatim (so -0, exponents etc. survive); `inputText` keeps it as a string too.
    const text = `{"name":${JSON.stringify(c.name)},"description":${JSON.stringify(c.description)},"input":${c.inputText},"inputText":${JSON.stringify(c.inputText)},"canonical":${JSON.stringify(c.canonical)}}`;
    writeFileSync(join(canonDir, `${c.name}.json`), `${text}\n`);
  }
  console.log(
    `wrote ${opsFixtures.length} ops, ${SAMPLES.length} node, ${CANONICAL_CASES.length} canonical fixtures to ${OUT}`,
  );
}

main();
