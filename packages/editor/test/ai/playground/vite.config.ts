import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// AI dock playground: the real editor shell and engine with a scripted AI backend, for visual checks and the
// screenshots in test/ai/shots (`node test/ai/playground/shots.mjs`). Port 4167.
const repo = fileURLToPath(new URL("../../../../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: { port: 4167, strictPort: true, host: "127.0.0.1", fs: { allow: [repo] } },
  preview: { port: 4167, strictPort: true, host: "127.0.0.1" },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@desyn/engine"] },
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
});
