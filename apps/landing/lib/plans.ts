import {
  type FeatureKey,
  isFeatureKey,
  type LimitKey,
  PLANS,
  type PlanId,
  type Plans,
} from "@desyn/schema/plans";

/**
 * Turns config/plans.json (the single source of truth for tiers, read through @desyn/schema like
 * every other client) into honest, human-readable feature lists. Nothing here is hand-maintained
 * marketing copy: if the JSON changes, the pricing page changes with it.
 */

export type { PlanId };

export const planConfig: Plans = PLANS;

export function hasFeature(planId: PlanId, key: string, config: Plans = planConfig): boolean {
  // An unknown key is never "included": a typo must not advertise a feature.
  return isFeatureKey(key) && config.plans[planId].features[key as FeatureKey] === true;
}

export function limitOf(planId: PlanId, key: LimitKey, config: Plans = planConfig): number | null {
  return config.plans[planId].limits[key];
}

export function formatStorage(mb: number | null): string {
  if (mb === null) return "Unlimited storage";
  if (mb >= 1024) return `${Math.round(mb / 1024)} GB storage`;
  return `${mb} MB storage`;
}

function count(n: number | null, singular: string, plural = `${singular}s`): string {
  if (n === null) return `Unlimited ${plural}`;
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

export interface PlanLine {
  text: string;
  /** false renders as a quiet "not included" line so lists stay honest. */
  included: boolean;
}

const FEATURE_GROUPS: { label: string; keys: FeatureKey[] }[] = [
  {
    label: "AI design agent: generate and edit by talking",
    keys: ["ai.agent", "ai.generateDesign"],
  },
  {
    label: "AI images, SVG, background removal, upscale",
    keys: ["ai.images", "ai.svg", "ai.removeBackground", "ai.upscale"],
  },
  { label: "Bring your own AI keys or local models", keys: ["ai.byok", "ai.local"] },
  { label: "Brand kits and “match my brand”", keys: ["brandKit"] },
  {
    label: "Magic resize, bulk create, campaigns",
    keys: ["magicResize", "bulkCreate", "campaign"],
  },
  { label: "Live collaboration and comments", keys: ["collab.live", "collab.comments"] },
  { label: "Premium templates", keys: ["templates.premium"] },
  {
    label: "SVG, PPTX, video and print PDF export",
    keys: ["export.svg", "export.pptx", "export.video", "export.pdfPrint"],
  },
  { label: "Custom fonts", keys: ["fonts.custom"] },
  {
    label: "Presentations, docs, whiteboards, websites",
    keys: ["presentation", "docs", "whiteboard", "website"],
  },
  { label: "Agent API and MCP server", keys: ["agentApi", "mcp"] },
];

/** Lines for a plan card. Ordered: limits first, then capabilities, then what is not included. */
export function planLines(planId: PlanId, config: Plans = planConfig): PlanLine[] {
  const lim = (k: LimitKey) => limitOf(planId, k, config);
  const lines: PlanLine[] = [];

  if (planId === "selfhost") {
    lines.push({ text: "Every feature, no limits", included: true });
    lines.push({ text: "Your own servers, your own data", included: true });
    lines.push({ text: "Your own AI providers and keys", included: true });
    lines.push({
      text: `Uploads up to ${((lim("uploadMbPerFile") ?? 0) / 1024).toFixed(0)} GB per file`,
      included: true,
    });
    lines.push({ text: "Non-commercial use only", included: true });
    return lines;
  }

  const credits = lim("creditsPerMonth");
  if (credits && credits > 0)
    lines.push({
      text: `${credits.toLocaleString("en-US")} AI credits every month`,
      included: true,
    });
  lines.push({ text: count(lim("designs"), "design"), included: true });
  lines.push({ text: `${count(lim("pagesPerDesign"), "page")} per design`, included: true });
  lines.push({ text: formatStorage(lim("storageMb")), included: true });
  lines.push({ text: `${lim("uploadMbPerFile")} MB per upload`, included: true });
  lines.push({ text: `${count(lim("exportsPerMonth"), "export")} a month`, included: true });

  const collaborators = lim("collaboratorsPerDesign");
  if (collaborators !== 0)
    lines.push({ text: `${count(collaborators, "collaborator")} per design`, included: true });
  const brandKits = lim("brandKits");
  if (brandKits !== 0) lines.push({ text: count(brandKits, "brand kit"), included: true });
  const history = lim("versionHistoryDays");
  if (history !== 0)
    lines.push({
      text: history === null ? "Unlimited version history" : `${history} days of version history`,
      included: true,
    });

  if (planId === "free") {
    const exports = ["export.png", "export.jpg", "export.pdf"].filter((k) =>
      hasFeature("free", k, config),
    );
    lines.push({
      text: `${exports.map((k) => k.split(".")[1]?.toUpperCase()).join(", ")} export`,
      included: true,
    });
    if (hasFeature("free", "templates.basic", config))
      lines.push({ text: "Basic templates", included: true });
    if (hasFeature("free", "fonts.google", config))
      lines.push({ text: "The full Google Fonts library", included: true });
    if (hasFeature("free", "share.viewLink", config))
      lines.push({ text: "View-only share links", included: true });
  }

  for (const group of FEATURE_GROUPS) {
    const included = group.keys.every((k) => hasFeature(planId, k, config));
    if (planId === "free" && !included) lines.push({ text: group.label, included: false });
    if (planId === "pro" && included) lines.push({ text: group.label, included: true });
  }
  return lines;
}

export interface PlanSummary {
  id: PlanId;
  name: string;
  priceMonthly: number;
  priceYearly: number | null;
  lines: PlanLine[];
}

export function planSummaries(config: Plans = planConfig): PlanSummary[] {
  return (["free", "pro", "selfhost"] as const).map((id) => {
    const plan = config.plans[id];
    return {
      id,
      name: plan.name,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly ?? null,
      lines: planLines(id, config),
    };
  });
}

/** Months of the monthly price you save by paying yearly (e.g. $96 vs $80 = 2 months). */
export function yearlySavingsMonths(planId: PlanId, config: Plans = planConfig): number {
  const p = config.plans[planId];
  if (!p.priceYearly || p.priceMonthly <= 0) return 0;
  return Math.round((p.priceMonthly * 12 - p.priceYearly) / p.priceMonthly);
}

/** Full comparison table rows for /pricing. */
export interface ComparisonRow {
  label: string;
  values: Record<PlanId, string | boolean>;
}

const LIMIT_ROWS: { key: LimitKey; label: string; format: (v: number | null) => string }[] = [
  {
    key: "creditsPerMonth",
    label: "AI credits per month",
    format: (v) => (v === null ? "Your own providers" : v === 0 ? "—" : v.toLocaleString("en-US")),
  },
  { key: "designs", label: "Designs", format: (v) => (v === null ? "Unlimited" : String(v)) },
  {
    key: "pagesPerDesign",
    label: "Pages per design",
    format: (v) => (v === null ? "Unlimited" : String(v)),
  },
  { key: "storageMb", label: "Storage", format: (v) => formatStorage(v).replace(" storage", "") },
  {
    key: "uploadMbPerFile",
    label: "Upload size per file",
    format: (v) => (v === null ? "Unlimited" : v >= 1024 ? `${v / 1024} GB` : `${v} MB`),
  },
  {
    key: "exportsPerMonth",
    label: "Exports per month",
    format: (v) => (v === null ? "Unlimited" : v.toLocaleString("en-US")),
  },
  {
    key: "collaboratorsPerDesign",
    label: "Collaborators per design",
    format: (v) => (v === null ? "Unlimited" : v === 0 ? "—" : String(v)),
  },
  {
    key: "brandKits",
    label: "Brand kits",
    format: (v) => (v === null ? "Unlimited" : v === 0 ? "—" : String(v)),
  },
  { key: "workspaces", label: "Workspaces", format: (v) => (v === null ? "Unlimited" : String(v)) },
  {
    key: "versionHistoryDays",
    label: "Version history",
    format: (v) => (v === null ? "Unlimited" : v === 0 ? "—" : `${v} days`),
  },
];

const FEATURE_ROWS: { label: string; keys: FeatureKey[] }[] = [
  { label: "Editor, layers, pages", keys: ["editor.core"] },
  { label: "PNG, JPG, PDF export", keys: ["export.png", "export.jpg", "export.pdf"] },
  {
    label: "WebP, SVG, PPTX, video, print PDF",
    keys: ["export.webp", "export.svg", "export.pptx", "export.video", "export.pdfPrint"],
  },
  { label: "Basic templates", keys: ["templates.basic"] },
  { label: "Premium templates", keys: ["templates.premium"] },
  { label: "Google Fonts", keys: ["fonts.google"] },
  { label: "Custom fonts", keys: ["fonts.custom"] },
  {
    label: "Auto-layout, pen tool, advanced effects",
    keys: ["layout.auto", "vector.pen", "effects.advanced"],
  },
  { label: "Charts, tables, QR codes", keys: ["charts", "tables", "qr"] },
  {
    label: "Presentations, docs, whiteboards, video, websites",
    keys: ["presentation", "docs", "whiteboard", "video", "website"],
  },
  { label: "AI agent: generate and edit designs", keys: ["ai.agent", "ai.generateDesign"] },
  { label: "AI images and SVG", keys: ["ai.images", "ai.svg"] },
  {
    label: "Background removal, inpaint, outpaint, upscale",
    keys: ["ai.removeBackground", "ai.inpaint", "ai.outpaint", "ai.upscale"],
  },
  { label: "Mockups, AI copy, translation", keys: ["ai.mockup", "ai.copy", "ai.translate"] },
  { label: "Bring your own keys, local models", keys: ["ai.byok", "ai.local"] },
  { label: "Brand kits", keys: ["brandKit"] },
  { label: "Magic resize, bulk create", keys: ["magicResize", "bulkCreate"] },
  { label: "Workflows, campaigns, localization", keys: ["workflows", "campaign", "localize"] },
  { label: "View-only share links", keys: ["share.viewLink"] },
  {
    label: "Edit links, live collaboration, comments",
    keys: ["share.editLink", "collab.live", "collab.comments"],
  },
  { label: "Teams and version history", keys: ["teams", "versionHistory"] },
  { label: "Agent API and MCP server", keys: ["agentApi", "mcp"] },
];

export function comparisonRows(config: Plans = planConfig): {
  limits: ComparisonRow[];
  features: ComparisonRow[];
} {
  const ids = ["free", "pro", "selfhost"] as const;
  const limits = LIMIT_ROWS.map((row) => ({
    label: row.label,
    values: Object.fromEntries(
      ids.map((id) => [id, row.format(limitOf(id, row.key, config))]),
    ) as Record<PlanId, string>,
  }));
  const features = FEATURE_ROWS.map((row) => ({
    label: row.label,
    values: Object.fromEntries(
      ids.map((id) => [id, row.keys.every((k) => hasFeature(id, k, config))]),
    ) as Record<PlanId, boolean>,
  }));
  return { limits, features };
}

export function creditCostRows(config: Plans = planConfig): { label: string; credits: number }[] {
  const labels: Record<string, string> = {
    "agent.turn": "One agent turn (a conversational edit)",
    "ai.generateDesign": "Generate a complete design",
    "ai.image": "Generate an image",
    "ai.svg": "Generate an SVG illustration",
    "ai.removeBackground": "Remove a background",
    "ai.upscale": "Upscale an image",
    "ai.inpaint": "Inpaint (replace part of an image)",
    "ai.outpaint": "Outpaint (extend an image)",
    "ai.mockup": "Place a design in a mockup",
    "ai.translate": "Translate a design",
    "ai.copy": "Write or rewrite copy",
    "workflow.campaignDesign": "Each design in a campaign",
    "workflow.resizeVariant": "Each resized variant",
    "workflow.localizeVariant": "Each localized variant",
    "ai.videoClip": "Generate a video clip",
  };
  return Object.entries(config.creditCosts).map(([key, credits]) => ({
    label: labels[key] ?? key,
    credits,
  }));
}
