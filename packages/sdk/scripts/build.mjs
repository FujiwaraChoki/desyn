// Bundles the SDK for publishing and the desyn-mcp binary (workspace packages are TypeScript sources, so
// the bundle inlines @desyn/schema; zod stays an external dependency).
import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  legalComments: "none",
  external: ["zod"],
  logLevel: "warning",
};

await mkdir("dist", { recursive: true });
await build({
  ...common,
  entryPoints: { index: "src/index.ts", mcp: "src/mcp/index.ts" },
  outdir: "dist",
  platform: "neutral",
});
await build({
  ...common,
  entryPoints: { "desyn-mcp": "src/bin/desyn-mcp.ts" },
  outdir: "dist",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/desyn-mcp.js", 0o755);
console.log("built dist/index.js, dist/mcp.js, dist/desyn-mcp.js");
