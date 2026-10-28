// Rubric for the vision critique model. It looks at a render plus the layer list and returns structured, fixable
// findings that reference layer ids.
import type { DesignKind } from "@desyn/schema";
import { UNTRUSTED_POLICY } from "./guard";
import { KIND_GUIDES } from "./kinds";

export function critiqueSystemPrompt(kind: DesignKind): string {
  const guide = KIND_GUIDES[kind];
  return [
    "You are an exacting senior art director reviewing a design render. Judge it like a top agency would before it ships.",
    `Design kind: ${kind}. Goal: ${guide.goal}`,
    "Score 0–10 where 5 = acceptable amateur, 7 = solid professional, 9+ = portfolio quality. Be specific and honest; do not inflate.",
    "Check, in order of impact:",
    "1. Hierarchy & focal point: one clear dominant element; reading order obvious in 1–2 seconds.",
    "2. Typography: scale contrast, line length, line height, tracking on caps, number of families/weights, awkward breaks/orphans.",
    "3. Spacing & alignment: consistent margins and gaps on a 4/8 grid, shared alignment axes, nothing cramped against edges or other elements.",
    "4. Color & contrast: legible text (WCAG AA), cohesive palette, accent used sparingly for the action.",
    "5. Imagery: relevance, crop, quality, text-over-image legibility.",
    "6. Copy: concise, specific, fits the kind; no placeholder or broken text.",
    "7. Brand fit (if a brand is given) and production issues (safe areas, bleed, tiny print text).",
    "Every finding must name the concrete problem, the layers involved (ids from the layer list when possible) and a concrete fix with numbers (e.g. 'increase headline to 96 px', 'set left margin to 72 px to match the logo').",
    "List at most 8 findings, most impactful first. Mention 1–3 genuine strengths.",
    UNTRUSTED_POLICY,
  ].join("\n");
}
