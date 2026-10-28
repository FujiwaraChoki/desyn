// Deterministic scoring for eval runs: structural rules over the design and the lints from `describe`
// (docs/DOCUMENT_MODEL.md §7). No model calls, so scores are reproducible for a given design.
import { descendants, pages } from "@desyn/doc-ops";
import type { Description, Design, Node, TextNode } from "@desyn/schema";
import { describeDesign } from "../src/design/describe";
import { textOf } from "../src/design/paint";
import type { GoldenCase } from "./golden";

export interface Check {
  name: string;
  pass: boolean;
  /** Share of the score this check is worth. */
  weight: number;
  detail: string;
}

export interface Score {
  caseId: string;
  /** 0..100 */
  score: number;
  pass: boolean;
  checks: Check[];
  issues: { code: string; severity: string; count: number }[];
}

export interface RunFacts {
  status: string;
  steps: number;
  credits: number;
}

function allText(nodes: Node[]): string {
  return nodes
    .filter((n): n is TextNode => n.type === "text")
    .map((n) => textOf(n))
    .join("\n");
}

function issueCounts(description: Description) {
  const counts = new Map<string, { code: string; severity: string; count: number }>();
  for (const issue of description.issues) {
    const key = `${issue.severity}:${issue.code}`;
    const entry = counts.get(key) ?? { code: issue.code, severity: issue.severity, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** Scores the first page of `design` against a golden case. */
export function scoreDesign(design: Design, golden: GoldenCase, run?: RunFacts): Score {
  const page = pages(design)[0];
  const checks: Check[] = [];
  const add = (name: string, weight: number, pass: boolean, detail: string) =>
    checks.push({ name, weight, pass, detail });

  if (!page) {
    return {
      caseId: golden.id,
      score: 0,
      pass: false,
      checks: [{ name: "has-page", pass: false, weight: 1, detail: "design has no pages" }],
      issues: [],
    };
  }
  const nodes = descendants(design, page.id);
  const visible = nodes.filter((n) => n.visible && n.opacity > 0.01);
  const description = describeDesign(design, { pageId: page.id });
  const text = allText(visible).toLowerCase();
  const texts = visible.filter((n): n is TextNode => n.type === "text" && textOf(n).trim() !== "");

  if (run) add("run-completed", 10, run.status === "completed", `status ${run.status}`);
  add("not-empty", 10, visible.length >= 2, `${visible.length} visible layer(s)`);

  const roles = new Set(nodes.map((n) => n.role).filter(Boolean));
  const missingRoles = golden.expect.roles.filter((r) => !roles.has(r));
  add(
    "roles",
    10,
    missingRoles.length === 0,
    missingRoles.length
      ? `missing roles: ${missingRoles.join(", ")}`
      : "all expected roles present",
  );

  const missingWords = (golden.expect.words ?? []).filter((w) => !text.includes(w.toLowerCase()));
  add(
    "copy",
    15,
    missingWords.length === 0,
    missingWords.length ? `missing copy: ${missingWords.join(", ")}` : "expected copy present",
  );
  const forbidden = (golden.expect.forbiddenWords ?? []).filter((w) =>
    texts.some((t) => textOf(t).toLowerCase().includes(w.toLowerCase())),
  );
  add(
    "no-forbidden-copy",
    10,
    forbidden.length === 0,
    forbidden.length ? `contains: ${forbidden.join(", ")}` : "clean",
  );
  if (golden.expect.minTextNodes !== undefined) {
    add(
      "text-count",
      5,
      texts.length >= golden.expect.minTextNodes,
      `${texts.length} text layer(s), want ≥ ${golden.expect.minTextNodes}`,
    );
  }
  const maxFonts = golden.expect.maxFonts ?? 3;
  add(
    "font-count",
    5,
    description.fonts.length <= maxFonts,
    `${description.fonts.length} famil(ies): ${description.fonts.map((f) => f.family).join(", ")}`,
  );

  const has = (code: string, severity?: string) =>
    description.issues.some((i) => i.code === code && (!severity || i.severity === severity));
  add("contrast", 10, !has("low-contrast"), has("low-contrast") ? "low-contrast text" : "AA");
  add("no-overflow", 10, !has("text-overflow"), has("text-overflow") ? "text overflows" : "fits");
  add("on-page", 5, !has("off-page"), has("off-page") ? "elements off the page" : "inside");
  add("legible", 5, !has("tiny-text"), has("tiny-text") ? "tiny text" : "legible");
  add(
    "hierarchy",
    5,
    !has("weak-hierarchy"),
    has("weak-hierarchy") ? "weak hierarchy" : "clear hierarchy",
  );
  const errors = description.issues.filter((i) => i.severity === "error").length;
  add("no-errors", 10, errors === 0, `${errors} error-level lint(s)`);

  const total = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const score = Math.round((earned / total) * 100);
  return {
    caseId: golden.id,
    score,
    pass: score >= golden.minScore,
    checks,
    issues: issueCounts(description),
  };
}

/** One-line-per-check text report for logs. */
export function formatScore(score: Score): string {
  return [
    `${score.pass ? "PASS" : "FAIL"} ${score.caseId}: ${score.score}/100`,
    ...score.checks.map((c) => `  ${c.pass ? "✓" : "✗"} ${c.name} (${c.weight}) — ${c.detail}`),
    ...(score.issues.length
      ? [`  lints: ${score.issues.map((i) => `${i.severity}:${i.code}×${i.count}`).join(", ")}`]
      : []),
  ].join("\n");
}
