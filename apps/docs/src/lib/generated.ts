import { slug } from "github-slugger";
import {
  API_ENDPOINTS,
  API_GROUPS,
  API_SCOPES,
  type ApiEndpoint,
  type ApiGroupId,
} from "../data/api.ts";
import { ENV_GROUPS, ENV_VARS, type EnvGroupId, type EnvVar } from "../data/env.ts";
import { SHORTCUT_GROUPS } from "../data/shortcuts.ts";
import {
  extractDeclarations,
  getSection,
  getSubsection,
  readDocumentModel,
} from "./document-model.ts";
import { escapeCell, escapeMdx, inlineCode, jsxAttr, table } from "./markdown.ts";
import { featureKeys, hasFeature, loadPlans, PLAN_ORDER, type PlanLimits } from "./plans.ts";

/**
 * Generated content blocks. MDX pages write `<Generated name="env-vars" />` and the remark
 * pipeline replaces the element with the parsed output of the matching generator, so the result
 * takes part in headings, the on-page TOC, search and link checking like hand-written content.
 */
export interface GeneratedBlock {
  /** "mdx" output may contain JSX components; "md" is plain CommonMark + GFM. */
  format: "mdx" | "md";
  text: string;
}

type Props = Record<string, string>;
type Generator = (props: Props) => GeneratedBlock;

const API_BASE = "https://api.desyn.app/api/v1";

function mdx(text: string): GeneratedBlock {
  return { format: "mdx", text };
}

function requireProp(props: Props, name: string, generator: string): string {
  const value = props[name];
  if (!value) throw new Error(`<Generated name="${generator}"> needs a "${name}" prop`);
  return value;
}

function heading(depth: number, text: string): string {
  return `${"#".repeat(depth)} ${text}`;
}

// ── Environment variables ───────────────────────────────────────────────────

function requiredLabel(v: EnvVar): string {
  if (v.required === "yes") return "required";
  if (v.required === "no") return "optional";
  return `required if ${v.requiredWhen ?? ""}`;
}

/** One variable as an <EnvVar> entry: readable at every width, unlike a five-column table. */
function envEntry(v: EnvVar): string {
  const where = v.targets.length ? v.targets.map((t) => TARGET_LABEL[t]).join(", ") : "CLI only";
  const attrs = [
    `name=${jsxAttr(v.name)}`,
    `required=${jsxAttr(requiredLabel(v))}`,
    `where=${jsxAttr(where)}`,
    v.defaultValue ? `defaultValue=${jsxAttr(v.defaultValue)}` : "",
    v.secret ? "secret" : "",
  ].filter(Boolean);
  const example = v.example ? ` Example: ${inlineCode(v.example)}` : "";
  return `<EnvVar ${attrs.join(" ")}>

${escapeMdx(v.description)}${example}

</EnvVar>`;
}

const TARGET_LABEL = { convex: "Convex", web: "Web app", worker: "Worker" } as const;

const envVars: Generator = (props) => {
  const groups = props.group
    ? ENV_GROUPS.filter((g) => g.id === (props.group as EnvGroupId))
    : ENV_GROUPS;
  if (groups.length === 0) throw new Error(`Unknown env group "${props.group}"`);
  const depth = Number(props.depth ?? "2");
  const parts: string[] = [];
  for (const group of groups) {
    const vars = ENV_VARS.filter((v) => v.group === group.id);
    if (props.group === undefined) parts.push(heading(depth, group.title));
    parts.push(escapeCell(group.intro));
    parts.push(`<EnvList>\n\n${vars.map(envEntry).join("\n\n")}\n\n</EnvList>`);
  }
  return mdx(parts.join("\n\n"));
};

// ── Keyboard shortcuts ──────────────────────────────────────────────────────

function keysCell(keys: string[]): string {
  return keys.map((combo) => `<Keys combo=${jsxAttr(combo)} />`).join(" or ");
}

const shortcuts: Generator = (props) => {
  const groups = props.group
    ? SHORTCUT_GROUPS.filter((g) => g.id === props.group)
    : SHORTCUT_GROUPS;
  if (groups.length === 0) throw new Error(`Unknown shortcut group "${props.group}"`);
  const parts: string[] = [];
  for (const group of groups) {
    if (!props.group) parts.push(heading(2, group.title));
    const rows = group.shortcuts.map((s) => [
      s.note
        ? `${escapeCell(s.action)} <small>${escapeCell(s.note)}</small>`
        : escapeCell(s.action),
      keysCell(s.keys),
    ]);
    parts.push(table(["Action", "Shortcut"], rows));
  }
  return mdx(parts.join("\n\n"));
};

// ── Plans ───────────────────────────────────────────────────────────────────

const LIMIT_LABELS: Record<keyof PlanLimits, string> = {
  designs: "Designs",
  pagesPerDesign: "Pages per design",
  storageMb: "Storage",
  uploadMbPerFile: "Max upload size",
  collaboratorsPerDesign: "Collaborators per design",
  brandKits: "Brand kits",
  workspaces: "Workspaces",
  exportsPerMonth: "Exports per month",
  versionHistoryDays: "Version history",
  creditsPerMonth: "AI credits per month",
};

function formatLimit(key: keyof PlanLimits, value: number | null, planId: string): string {
  if (value === null) {
    if (key === "creditsPerMonth" && planId === "selfhost") return "Unlimited (your own keys)";
    return "Unlimited";
  }
  switch (key) {
    case "storageMb":
    case "uploadMbPerFile":
      return value >= 1024 ? `${+(value / 1024).toFixed(1)} GB` : `${value} MB`;
    case "versionHistoryDays":
      return value === 0 ? "Not included" : `${value} days`;
    case "collaboratorsPerDesign":
    case "brandKits":
    case "creditsPerMonth":
      return value === 0 ? "Not included" : value.toLocaleString("en-US");
    default:
      return value.toLocaleString("en-US");
  }
}

const planLimits: Generator = () => {
  const config = loadPlans();
  const header = ["", ...PLAN_ORDER.map((id) => config.plans[id].name)];
  const price = [
    "Price",
    ...PLAN_ORDER.map((id) => {
      const plan = config.plans[id];
      if (id === "selfhost") return "Free (non-commercial)";
      if (plan.priceMonthly === 0) return "Free";
      return plan.priceYearly
        ? `$${plan.priceMonthly}/month or $${plan.priceYearly}/year`
        : `$${plan.priceMonthly}/month`;
    }),
  ];
  const keys = Object.keys(LIMIT_LABELS) as (keyof PlanLimits)[];
  const rows = keys.map((key) => [
    LIMIT_LABELS[key],
    ...PLAN_ORDER.map((id) => formatLimit(key, config.plans[id].limits[key], id)),
  ]);
  return mdx(table(header, [price, ...rows]));
};

/** Human labels for the feature flags in config/plans.json, grouped for display. */
export const FEATURE_LABELS: Record<string, { group: string; label: string }> = {
  "editor.core": { group: "Editor", label: "Full editor" },
  "templates.basic": { group: "Templates", label: "Basic templates" },
  "templates.premium": { group: "Templates", label: "Premium templates" },
  "export.png": { group: "Export", label: "PNG" },
  "export.jpg": { group: "Export", label: "JPEG" },
  "export.pdf": { group: "Export", label: "PDF" },
  "export.webp": { group: "Export", label: "WebP" },
  "export.svg": { group: "Export", label: "SVG" },
  "export.pptx": { group: "Export", label: "PowerPoint (PPTX)" },
  "export.video": { group: "Export", label: "Video (MP4, GIF)" },
  "export.pdfPrint": { group: "Export", label: "Print PDF (bleed, crop marks)" },
  "share.viewLink": { group: "Sharing", label: "View links" },
  "share.editLink": { group: "Sharing", label: "Edit links" },
  "fonts.google": { group: "Editor", label: "Google Fonts" },
  "fonts.custom": { group: "Editor", label: "Custom font upload" },
  "layout.auto": { group: "Editor", label: "Auto-layout" },
  "vector.pen": { group: "Editor", label: "Pen tool & boolean operations" },
  "effects.advanced": { group: "Editor", label: "Advanced effects" },
  charts: { group: "Elements", label: "Charts" },
  tables: { group: "Elements", label: "Tables" },
  qr: { group: "Elements", label: "QR codes" },
  presentation: { group: "Design kinds", label: "Presentations" },
  docs: { group: "Design kinds", label: "Documents" },
  whiteboard: { group: "Design kinds", label: "Whiteboards" },
  video: { group: "Design kinds", label: "Video" },
  website: { group: "Design kinds", label: "One-page websites" },
  "ai.agent": { group: "AI", label: "Conversational agent" },
  "ai.generateDesign": { group: "AI", label: "Generate complete designs" },
  "ai.images": { group: "AI", label: "Image generation" },
  "ai.svg": { group: "AI", label: "SVG generation" },
  "ai.removeBackground": { group: "AI", label: "Background removal" },
  "ai.inpaint": { group: "AI", label: "Inpaint" },
  "ai.outpaint": { group: "AI", label: "Outpaint" },
  "ai.upscale": { group: "AI", label: "Upscale" },
  "ai.mockup": { group: "AI", label: "Mockups" },
  "ai.copy": { group: "AI", label: "Copywriting" },
  "ai.translate": { group: "AI", label: "Translation" },
  "ai.byok": { group: "AI", label: "Bring your own key" },
  "ai.local": { group: "AI", label: "Local models" },
  brandKit: { group: "Brand & workflows", label: "Brand kits" },
  magicResize: { group: "Brand & workflows", label: "Magic resize" },
  bulkCreate: { group: "Brand & workflows", label: "Bulk create (CSV)" },
  workflows: { group: "Brand & workflows", label: "Workflows" },
  campaign: { group: "Brand & workflows", label: "Campaigns" },
  localize: { group: "Brand & workflows", label: "Localize" },
  "collab.live": { group: "Collaboration", label: "Real-time collaboration" },
  "collab.comments": { group: "Collaboration", label: "Comments" },
  teams: { group: "Collaboration", label: "Teams" },
  versionHistory: { group: "Collaboration", label: "Version history" },
  agentApi: { group: "Developers", label: "Agent REST API" },
  mcp: { group: "Developers", label: "MCP server" },
};

const planFeatures: Generator = () => {
  const config = loadPlans();
  const keys = featureKeys(config);
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const meta = FEATURE_LABELS[key];
    if (!meta) throw new Error(`No docs label for plan feature "${key}"; add it to FEATURE_LABELS`);
    groups.set(meta.group, [...(groups.get(meta.group) ?? []), key]);
  }
  const header = ["Feature", ...PLAN_ORDER.map((id) => config.plans[id].name)];
  const rows: string[][] = [];
  for (const [group, groupKeys] of groups) {
    rows.push([`**${group}**`, "", "", ""]);
    for (const key of groupKeys) {
      rows.push([
        FEATURE_LABELS[key]?.label ?? key,
        ...PLAN_ORDER.map((id) => (hasFeature(config.plans[id], key) ? "✓" : "—")),
      ]);
    }
  }
  return mdx(table(header, rows));
};

const CREDIT_LABELS: Record<string, string> = {
  "agent.turn": "Agent turn (one request to the agent, any number of edits)",
  "ai.generateDesign": "Generate a complete design",
  "ai.image": "Generate an image",
  "ai.svg": "Generate an SVG",
  "ai.removeBackground": "Remove background",
  "ai.upscale": "Upscale",
  "ai.inpaint": "Inpaint",
  "ai.outpaint": "Outpaint",
  "ai.mockup": "Mockup",
  "ai.translate": "Translate a design",
  "ai.copy": "Write or rewrite copy",
  "workflow.campaignDesign": "Campaign: each design produced",
  "workflow.resizeVariant": "Resize: each size produced",
  "workflow.localizeVariant": "Localize: each language produced",
  "ai.videoClip": "Generate a video clip",
};

const creditCosts: Generator = () => {
  const config = loadPlans();
  const rows = Object.entries(config.creditCosts).map(([key, cost]) => {
    const label = CREDIT_LABELS[key];
    if (!label) throw new Error(`No docs label for credit cost "${key}"; add it to CREDIT_LABELS`);
    return [label, inlineCode(key), String(cost)];
  });
  return mdx(table(["Action", "Key", "Credits"], rows));
};

const fairUse: Generator = () => {
  const f = loadPlans().fairUse;
  const [minDelay, maxDelay] = f.throttleDelayMs;
  const lines = [
    `- **No overage charges.** ${f.noOverageCharges ? "You are never billed for usage beyond your plan." : ""}`,
    `- **Soft throttle.** When the monthly pool is used up, AI requests keep working but each waits ${minDelay / 1000}–${maxDelay / 1000} seconds before it starts.`,
    `- **Bring your own key bypasses credits.** ${f.byokBypassesCredits ? "Requests that run on your own provider key or a local model never spend credits." : ""}`,
    `- **Rate caps.** Up to ${f.perMinuteAiRequests} AI requests per minute and ${f.perDayAiRequests} per day per account.`,
    `- **Concurrency.** Up to ${f.maxConcurrentRuns} agent runs or workflows at the same time.`,
    `- **Collaborators.** Up to ${f.maxCollaboratorsPerDesign} people per design.`,
  ];
  return mdx(lines.join("\n"));
};

// ── Agent API ───────────────────────────────────────────────────────────────

function curlFor(e: ApiEndpoint): string {
  const urlPath = e.path.replace(/\{(\w+)\}/g, (_m, name: string) => `$${toShellVar(name)}`);
  const lines = [`curl${e.method === "GET" ? "" : ` -X ${e.method}`} "${API_BASE}${urlPath}" \\`];
  lines.push(`  -H "Authorization: Bearer $DESYN_API_KEY"${e.request !== undefined ? " \\" : ""}`);
  if (e.request !== undefined) {
    lines.push(`  -H "Content-Type: application/json" \\`);
    const body = JSON.stringify(e.request, null, 2).replace(/'/g, "'\\''");
    lines.push(`  -d '${body}'`);
  }
  if (typeof e.response === "string" && e.response.startsWith("<binary")) {
    lines[lines.length - 1] += " \\";
    lines.push("  --output preview.webp");
  }
  return lines.join("\n");
}

function toShellVar(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Endpoint parameters as a <Params> list (stacks cleanly on small screens). */
function paramList(e: ApiEndpoint): string {
  const items = e.params.map((p) => {
    const attrs = [
      `name=${jsxAttr(p.name)}`,
      `location=${jsxAttr(p.in)}`,
      `type=${jsxAttr(p.type)}`,
      p.required ? "required" : "",
    ].filter(Boolean);
    return `<Param ${attrs.join(" ")}>\n\n${escapeMdx(p.description)}\n\n</Param>`;
  });
  return `<Params>\n\n${items.join("\n\n")}\n\n</Params>`;
}

function endpointBlock(e: ApiEndpoint, depth: number): string {
  const parts = [
    heading(depth, e.title),
    `<Endpoint method=${jsxAttr(e.method)} path=${jsxAttr(e.path)} fn=${jsxAttr(e.fn)} scope=${jsxAttr(e.scope)} />`,
    escapeMdx(e.description),
  ];
  if (e.params.length) {
    parts.push(paramList(e));
  }
  const response =
    typeof e.response === "string"
      ? `\`\`\`text title="${e.status ?? 200} OK"\n${e.response}\n\`\`\``
      : `\`\`\`json title="${e.status ?? 200} ${e.status === 201 ? "Created" : e.status === 202 ? "Accepted" : "OK"}"\n${JSON.stringify(e.response, null, 2)}\n\`\`\``;
  parts.push(
    `<Tabs>\n<Tab label="Request">\n\n\`\`\`bash\n${curlFor(e)}\n\`\`\`\n\n</Tab>\n<Tab label="Response">\n\n${response}\n\n</Tab>\n</Tabs>`,
  );
  return parts.join("\n\n");
}

const apiEndpoints: Generator = (props) => {
  const page = props.page;
  const groups = API_GROUPS.filter((g) => (page ? g.page === page : true)).filter((g) =>
    props.group ? g.id === (props.group as ApiGroupId) : true,
  );
  if (groups.length === 0)
    throw new Error(`No API groups match page="${page}" group="${props.group}"`);
  const parts: string[] = [];
  for (const group of groups) {
    parts.push(heading(2, group.title), group.intro);
    for (const endpoint of API_ENDPOINTS.filter((e) => e.group === group.id)) {
      parts.push(endpointBlock(endpoint, 3));
    }
  }
  return mdx(parts.join("\n\n"));
};

const apiIndex: Generator = () => {
  const rows = API_ENDPOINTS.map((e) => {
    const group = API_GROUPS.find((g) => g.id === e.group);
    const href = `/developers/api/${group?.page}#${slug(e.title)}`;
    return [
      `<Method method=${jsxAttr(e.method)} />`,
      `[${inlineCode(e.path)}](${href})`,
      escapeCell(e.title),
      inlineCode(e.scope),
    ];
  });
  return mdx(table(["Method", "Path", "Endpoint", "Scope"], rows));
};

const apiScopes: Generator = () =>
  mdx(
    table(
      ["Scope", "Allows"],
      API_SCOPES.map((s) => [inlineCode(s.scope), escapeCell(s.description)]),
    ),
  );

// ── Document model ──────────────────────────────────────────────────────────

const modelSection: Generator = (props) => {
  const key = requireProp(props, "section", "model-section");
  const section = getSection(readDocumentModel(), key);
  const scoped = props.subsection ? getSubsection(section.body, props.subsection) : section.body;
  // `prose` drops fenced code so a page can show the rules without repeating type excerpts.
  const source = props.prose ? scoped.replace(/```[\s\S]*?```\n?/g, "").trim() : scoped;
  const shift = Number(props.shift ?? "0");
  const body = shift
    ? source.replace(
        /^(#{2,6}) /gm,
        (_m, hashes: string) => `${"#".repeat(Math.max(2, hashes.length + shift))} `,
      )
    : source;
  return { format: "md", text: body };
};

const modelTypes: Generator = (props) => {
  const names = requireProp(props, "names", "model-types")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const code = extractDeclarations(readDocumentModel(), names);
  return { format: "md", text: `\`\`\`ts title="docs/DOCUMENT_MODEL.md"\n${code}\n\`\`\`` };
};

export const GENERATORS: Record<string, Generator> = {
  "env-vars": envVars,
  shortcuts,
  "plan-limits": planLimits,
  "plan-features": planFeatures,
  "credit-costs": creditCosts,
  "fair-use": fairUse,
  "api-endpoints": apiEndpoints,
  "api-index": apiIndex,
  "api-scopes": apiScopes,
  "model-section": modelSection,
  "model-types": modelTypes,
};

export function generate(name: string, props: Props): GeneratedBlock {
  const generator = GENERATORS[name];
  if (!generator) throw new Error(`Unknown <Generated name="${name}">`);
  return generator(props);
}
