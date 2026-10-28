import { fileURLToPath } from "node:url";
// Plugins come from @desyn/ui's dev dependencies (the editor package has no Vite of its own).
import tailwindcss from "../../../../ui/node_modules/@tailwindcss/vite/dist/index.mjs";
import react from "../../../../ui/node_modules/@vitejs/plugin-react/dist/index.js";
import { defineConfig } from "../../../../ui/node_modules/vite/dist/node/index.js";

/**
 * Panels screenshot harness (not shipped): `node test/panels/harness/shots.mjs` starts it on 4101 + n and
 * drives it with Playwright. Sample photos are served from `HARNESS_ASSETS` (generated into the scratchpad).
 */
const repo = fileURLToPath(new URL("../../../../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: process.env.HARNESS_ASSETS ?? false,
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: Number(process.env.HARNESS_PORT ?? 4106),
    strictPort: true,
    host: "127.0.0.1",
    fs: { allow: [repo] },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@desyn/engine"] },
});
