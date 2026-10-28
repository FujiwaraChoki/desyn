import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";

// Browser harness for the canvas interaction layer: the real engine (wasm in a worker), the real editor shell
// and extensions on an in-memory backend (test/fake-server.ts), with a generated 2,000-layer design.
// Test-only; never shipped. Run from packages/editor:
//   node_modules/.bin/vite --config test/canvas/perf/vite.config.ts            (dev, http://127.0.0.1:4108)
//   node_modules/.bin/vite build --config test/canvas/perf/vite.config.ts      (production build, React prod)
//   node_modules/.bin/vite preview --config test/canvas/perf/vite.config.ts    (serves the build on :4108)
//   node test/canvas/perf/perf.mjs                                              (frame timings + screenshots)
const repo = fileURLToPath(new URL("../../../../..", import.meta.url));
const ui = createRequire(new URL("../../../../ui/package.json", import.meta.url));
const load = async (name: string) => (await import(pathToFileURL(ui.resolve(name)).href)).default;

export default defineConfig(async () => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [(await load("@vitejs/plugin-react"))(), (await load("@tailwindcss/vite"))()],
  // No HMR / file watching: measurements must not be interrupted by reloads while the repo changes.
  server: {
    port: 4108,
    strictPort: true,
    host: "127.0.0.1",
    fs: { allow: [repo] },
    hmr: false,
    watch: { ignored: ["**/*"] },
  },
  preview: { port: 4108, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
  worker: { format: "es" as const },
  optimizeDeps: { exclude: ["@desyn/engine"] },
}));
