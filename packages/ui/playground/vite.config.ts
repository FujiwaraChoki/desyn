import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@desyn/ui": fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
  },
  server: { port: 4101, strictPort: true, host: "127.0.0.1" },
  preview: { port: 4101, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
