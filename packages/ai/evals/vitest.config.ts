import { defineConfig } from "vitest/config";

// Evals call real providers; they are opt-in (`pnpm evals`) and never part of `pnpm test`.
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    // One case at a time: real rate limits, readable logs.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
