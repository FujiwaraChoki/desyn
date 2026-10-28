// Writes JSON Schema (draft 2020-12) generated from the zod schemas into packages/schema/json-schema/*.json.
// Run: pnpm --filter @desyn/schema gen:json-schema   (the output is committed; a test checks it is up to date)
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchemaDocuments } from "../src/json-schema";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../json-schema");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".json")) rmSync(join(out, f));
const docs = jsonSchemaDocuments();
for (const [name, doc] of Object.entries(docs)) {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(docs).length} JSON Schema files to ${out}`);
