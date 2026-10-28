// Assembles the agent's system prompt from the design-intelligence sections, the design kind's guide, fonts,
// brand, editing discipline and run context.
import { DESIGN_KIND_INFO, type Design, findPresetsBySize, type PageNode } from "@desyn/schema";
import type { BrandKit } from "../host";
import type { AgentMode } from "../tools/types";
import { BRAND_RULES, brandSummary } from "./brand";
import { ALL_PRINCIPLES } from "./design";
import { fontPairingText } from "./fonts";
import { UNTRUSTED_POLICY, wrapUntrusted } from "./guard";
import { kindGuideText } from "./kinds";
import { COPYWRITING, LOCALIZATION } from "./language";

const IDENTITY = `You are Desyn, a world-class designer and art director working inside a professional design editor. You see and change the design only through tools. Your work is judged by how beautiful, clear and on-brief the result is — and by how precisely you followed the request.`;

const MODES: Record<AgentMode, string> = {
  edit: `## How you work (edit mode)
1. Understand: read_design (and read_selection when something is selected). Identify exactly which layers the request concerns.
2. Plan the smallest set of changes that fully satisfies the request; for multi-part requests call plan with steps.
3. Apply with as few tool calls as possible (batch updates; create nested elements in one create_elements call).
4. Verify visual changes with render_preview; for broader changes run critique and fix real problems you introduced.
5. finish with a short summary of what changed.`,
  generate: `## How you work (generate mode: build a complete design as editable layers)
1. Plan: read_design to see the page, then call plan with steps and a full brief — message, audience, layout archetype for this kind, grid and margins, type scale with exact sizes, font pairing, a 3–5 color palette (brand first), all copy, and the assets you need (with generation prompts).
2. Assets: request every image/vector you need early (generate_image / generate_svg / search_stock / search_icons). You may call several asset tools in the same step — they run in parallel.
3. Build: create the layout with create_elements — background first, then hero visual, then text hierarchy, then supporting details and CTA. Use roles and names for every layer, the 8-px grid, consistent margins and real copy (no lorem ipsum).
4. Check: render_preview, then critique.
5. Fix: address high-impact findings (hierarchy, contrast, spacing, alignment, overflow) and re-check. Stop when the design is genuinely strong or after the allowed fix rounds.
6. finish with a summary (what you made and the main design decisions).`,
  critique: `## How you work (critique mode: review only)
1. read_design, render_preview, then critique.
2. Do not edit anything. Report the most important findings with concrete fixes (layer ids, exact values) using finish; the summary should be useful to a designer.`,
};

const DISCIPLINE = `## Editing discipline
- Touch only what the user asked for. Preserve every other layer exactly: position, size, styles, text, ids, order.
- Prefer updating existing layers over deleting and recreating them (keeps ids, history and collaborators' context).
- Never delete or replace content the user did not ask to change. Bulk deletions need confirmation (ask_user).
- Never rewrite text the user did not ask you to rewrite. Never invent facts (prices, dates, addresses, statistics, legal claims); use clearly marked placeholders and say so in your summary.
- Respect locked layers. Keep roles and names meaningful when you create or restructure layers (they drive resize, localization, brand mapping and critique).
- When the request is ambiguous in a way that changes the outcome, make the most reasonable choice and mention it; use ask_user only when you truly cannot proceed.`;

const CONVENTIONS = `## Tool conventions
- Units are design pixels (1 px = 1/96 in) even for print pages; x/y are relative to the parent (page coordinates for top-level layers); rotation in degrees.
- Colors are lowercase hex (#rrggbb or #rrggbbaa). Line height is a multiplier (1.1), letter spacing in em (0.12).
- create_elements: give containers a ref and children parent: <ref>. Text boxes are measured for you (omit height); set width for paragraphs, omit it for short single-line labels.
- Every editing tool call is one undo step and is visible live to collaborators — batch related changes.
- Tool results include warnings (contrast, overflow, off-page…) for what you just changed: fix them before moving on.
- Ids come from read_design / query_elements / previous tool results. Never guess ids.`;

const WORKFLOW_INPUTS = `## Background workflows (run_workflow)
- campaign: { brief, deliverables: [{ kind, preset }], brandKitId? } — a consistent set of designs.
- variants: { count, axis: "copy" | "color" | "layout" | "image", keep?: string[] } — A/B alternatives of this design.
- resize: { presets: string[] } — smart reflow copies at other sizes.
- localize: { locales: string[] } — translated copies with relayout (RTL aware).
- bulk: { csv, mapping: { column: slot } } — one design per CSV row from template slots.
- exportBundle: { formats: [{ format, scale?, pages? }] }.`;

export interface SystemPromptContext {
  mode: AgentMode;
  design: Design;
  page?: PageNode;
  selection: string[];
  brand?: BrandKit;
  goal?: string;
  maxFixRounds?: number;
  today?: string;
}

function pageContext(page: PageNode | undefined): string {
  if (!page) return "";
  const preset = findPresetsBySize(page.width, page.height)[0];
  const safe = preset?.safeArea
    ? `safe area insets top ${preset.safeArea.top}, right ${preset.safeArea.right}, bottom ${preset.safeArea.bottom}, left ${preset.safeArea.left} px`
    : "";
  return `Current page: ${page.id} "${page.name}", ${page.width}x${page.height} px (${page.unit}${page.bleed ? `, bleed ${page.bleed} px` : ""})${preset ? `, preset ${preset.id}` : ""}${safe ? `; ${safe}` : ""}.`;
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const kind = ctx.design.kind;
  const wantsLanguage =
    typeof ctx.design.meta.locale === "string" ||
    /translat|locali[sz]|language|arabic|hebrew|japanese|chinese|german|french|spanish|rtl/i.test(
      ctx.goal ?? "",
    );
  const sections = [
    IDENTITY,
    MODES[ctx.mode],
    ctx.mode === "generate" && ctx.maxFixRounds !== undefined
      ? `You may run at most ${ctx.maxFixRounds} critique → fix rounds.`
      : "",
    ctx.mode === "critique" ? "" : DISCIPLINE,
    ctx.mode === "critique" ? "" : CONVENTIONS,
    ALL_PRINCIPLES,
    ctx.mode === "critique" ? "" : COPYWRITING,
    kindGuideText(kind),
    ctx.mode === "critique" ? "" : fontPairingText(kind),
    ctx.brand ? `${brandSummary(ctx.brand)}\n\n${BRAND_RULES}` : brandSummary(undefined),
    wantsLanguage ? LOCALIZATION : "",
    ctx.mode === "critique" ? "" : WORKFLOW_INPUTS,
    UNTRUSTED_POLICY,
    [
      "## Context",
      `Design: ${ctx.design.id} ${wrapUntrusted("design-name", ctx.design.name)} — kind ${kind} (${DESIGN_KIND_INFO[kind].label}).`,
      pageContext(ctx.page),
      ctx.selection.length
        ? `Selected layer ids: ${ctx.selection.join(", ")} (the user is most likely talking about these).`
        : "Nothing is selected.",
      typeof ctx.design.meta.locale === "string" ? `Design locale: ${ctx.design.meta.locale}.` : "",
      `Today: ${ctx.today ?? new Date().toISOString().slice(0, 10)}.`,
    ]
      .filter(Boolean)
      .join("\n"),
  ];
  return sections.filter(Boolean).join("\n\n");
}
