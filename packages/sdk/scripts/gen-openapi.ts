// Writes the OpenAPI 3.1 document of the Agent API v1 to openapi.json (package root) and to the docs site
// (apps/docs/public/openapi.json). The Convex endpoint GET /api/v1/openapi.json serves the same document.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "../src/openapi";

const json = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
const targets = ["../openapi.json", "../../../apps/docs/public/openapi.json"].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);
for (const target of targets) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, json);
}
console.log(`wrote ${targets.join(", ")} (${json.length} bytes)`);
