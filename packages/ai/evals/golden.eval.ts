// Golden-prompt evals against real providers. Run with `pnpm --filter @desyn/ai evals`.
// Needs OPENROUTER_API_KEY (text); FAL_AI_API_KEY is optional (without it designs are built from type, shapes
// and color only). Without a text key every case is skipped. Set DESYN_EVAL_REPORT=<path> to also write a JSON
// report, and DESYN_EVAL_CASES=id1,id2 to run a subset.
import { writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { generateDesign } from "../src/agent/generate";
import { runAgent } from "../src/agent/run";
import { MemoryHost } from "../src/memory-host";
import { createProviders, envProviderConfigs, processEnv } from "../src/providers";
import { GOLDEN_CASES } from "./golden";
import { formatScore, type Score, scoreDesign } from "./score";
import { seedDesign } from "./seed";

const env = processEnv();
const configs = envProviderConfigs(env);
const hasText = Boolean(configs.openrouter);
const only = env.DESYN_EVAL_CASES?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const cases = GOLDEN_CASES.filter((c) => !only?.length || only.includes(c.id));
const results: (Score & { credits: number; steps: number; ms: number; summary: string })[] = [];

describe.skipIf(!hasText)("golden evals", () => {
  const providers = createProviders({ env: configs });

  for (const golden of cases) {
    it(golden.id, async () => {
      const host = new MemoryHost(seedDesign(golden));
      const started = Date.now();
      const run =
        golden.mode === "generate"
          ? await generateDesign({
              host,
              prompt: golden.prompt,
              kind: golden.kind,
              providers,
              maxSteps: 40,
              budget: { credits: 60 },
            })
          : await runAgent({
              host,
              goal: golden.prompt,
              mode: "edit",
              providers,
              maxSteps: 16,
              budget: { credits: 20 },
            });
      const score = scoreDesign(host.getDesign(), golden, run);
      results.push({
        ...score,
        credits: run.credits,
        steps: run.steps,
        ms: Date.now() - started,
        summary: run.summary,
      });
      console.log(
        `${formatScore(score)}\n  run: ${run.status}, ${run.steps} steps, ${run.credits} credits`,
      );
      expect(score.score).toBeGreaterThanOrEqual(golden.minScore);
    });
  }

  afterAll(async () => {
    const path = env.DESYN_EVAL_REPORT;
    if (!path || results.length === 0) return;
    const mean = results.reduce((s, r) => s + r.score, 0) / results.length;
    await writeFile(
      path,
      JSON.stringify({ at: new Date().toISOString(), mean: Math.round(mean), results }, null, 2),
    );
  });
});
