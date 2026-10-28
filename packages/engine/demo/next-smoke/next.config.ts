import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Minimal Next 16 consumer of @desyn/engine, built exactly the way apps/web consumes workspace packages:
// TypeScript sources transpiled by Next, the worker created with `new Worker(new URL("./worker.ts",
// import.meta.url), { type: "module" })` inside the package, and the wasm modules referenced with
// `new URL("../wasm/*.wasm", import.meta.url)` so Turbopack emits them as static assets. No webpack /
// `asyncWebAssembly` configuration is involved: the wasm is fetched and instantiated by the wasm-bindgen glue.
const repo = fileURLToPath(new URL("../../../..", import.meta.url));

const config: NextConfig = {
  turbopack: {
    root: repo,
    // apps/web depends on @desyn/engine through the workspace; this smoke app lives inside the package itself.
    resolveAlias: { "@desyn/engine": "./packages/engine/src/index.ts" },
  },
  transpilePackages: ["@desyn/engine", "@desyn/schema", "@desyn/doc-ops"],
  reactStrictMode: true,
};

export default config;
