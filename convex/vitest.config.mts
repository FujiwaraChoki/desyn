import { defineConfig } from "vitest/config";

// Offline tests for the Convex backend (convex-test runs functions in an edge-runtime mock).
// Run from the repo root: pnpm test:convex
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    testTimeout: 30_000,
  },
});
