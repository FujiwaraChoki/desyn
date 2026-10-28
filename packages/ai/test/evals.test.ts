import type { Node, TextNode } from "@desyn/schema";
import { describe, expect, it } from "vitest";
import { GOLDEN_CASES } from "../evals/golden";
import { formatScore, scoreDesign } from "../evals/score";
import { seedDesign } from "../evals/seed";
import { sampleDesign } from "./helpers";

const editCase = GOLDEN_CASES.find((c) => c.id === "edit-headline-only");

describe("eval scoring (offline)", () => {
  it("has unique golden ids and builds every seed", () => {
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(GOLDEN_CASES.length);
    for (const c of GOLDEN_CASES)
      expect(Object.keys(seedDesign(c).nodes).length).toBeGreaterThan(1);
  });

  it("scores a clean design high and explains failures", () => {
    if (!editCase) throw new Error("edit case missing");
    const { design } = sampleDesign();
    const before = scoreDesign(design, editCase, { status: "completed", steps: 3, credits: 3 });
    // The seed still says "Spring collection": copy check fails, forbidden copy fails.
    expect(before.checks.find((c) => c.name === "copy")?.pass).toBe(false);
    expect(before.checks.find((c) => c.name === "no-forbidden-copy")?.pass).toBe(false);
    expect(before.pass).toBe(false);

    const edited = structuredClone(design);
    const headline = Object.values(edited.nodes).find(
      (n): n is TextNode => n.type === "text" && n.role === "headline",
    ) as TextNode;
    headline.runs = [{ text: "Summer is here" }];
    const after = scoreDesign(edited, editCase, { status: "completed", steps: 3, credits: 3 });
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.checks.find((c) => c.name === "copy")?.pass).toBe(true);
    expect(formatScore(after)).toMatch(/^(PASS|FAIL) edit-headline-only: \d+\/100/);
  });

  it("penalizes off-page layers, failed runs and empty pages", () => {
    if (!editCase) throw new Error("edit case missing");
    const { design, ids } = sampleDesign();
    const broken = structuredClone(design);
    (broken.nodes[ids.body] as Node).x = 5000;
    const s = scoreDesign(broken, editCase, { status: "failed", steps: 1, credits: 1 });
    expect(s.checks.find((c) => c.name === "on-page")?.pass).toBe(false);
    expect(s.checks.find((c) => c.name === "run-completed")?.pass).toBe(false);
    const empty = scoreDesign(seedDesign({ ...editCase, mode: "generate" }), editCase);
    expect(empty.checks.find((c) => c.name === "not-empty")?.pass).toBe(false);
  });
});
