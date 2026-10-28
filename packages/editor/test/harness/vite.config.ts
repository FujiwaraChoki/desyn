import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";

// Browser harness for the collaboration / export / present features: the real engine (wasm in a worker),
// the real editor shell, scripted backends (test/collab/fake-collab.ts). Test-only; never shipped.
// Run: node_modules/.bin/vite --config test/harness/vite.config.ts  (from packages/editor, uses packages/ui's
// Tailwind + React plugins).
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const ui = createRequire(new URL("../../../ui/package.json", import.meta.url));
const load = async (name: string) => (await import(pathToFileURL(ui.resolve(name)).href)).default;

export default defineConfig(async () => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [(await load("@vitejs/plugin-react"))(), (await load("@tailwindcss/vite"))()],
  server: { port: 4107, strictPort: true, host: "127.0.0.1", fs: { allow: [repo] } },
  worker: { format: "es" as const },
  optimizeDeps: { exclude: ["@desyn/engine"] },
}));
