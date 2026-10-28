import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // The engine package is TypeScript source (the internal-package pattern), served as-is.
  server: {
    port: 4105,
    strictPort: true,
    host: "127.0.0.1",
    // spec/fixtures live outside the package.
    fs: { allow: [repo] },
  },
  preview: { port: 4105, strictPort: true, host: "127.0.0.1" },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
  optimizeDeps: { exclude: ["@desyn/engine"] },
});
