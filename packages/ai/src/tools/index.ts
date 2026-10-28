// The design tool set (names exact per docs/SPEC.md §7). Tools that need an unavailable capability (media
// providers, stock/icon/template search, workflows, copy/translate models) are left out of the set so the model
// never sees tools it cannot use.
import { asSchema, type ToolSet } from "ai";
import { arrangeTools } from "./arrange";
import { assetTools } from "./assets";
import { controlTools } from "./control";
import { critiqueTools } from "./critique";
import { editTools } from "./edit";
import { pageTools } from "./pages";
import { readTools } from "./read";
import { searchTools } from "./search";
import { textTools } from "./text";
import type { AgentMode, ToolContext } from "./types";
import { createRunState } from "./types";

export const TOOL_NAMES = [
  "read_design",
  "read_selection",
  "render_preview",
  "query_elements",
  "create_elements",
  "update_elements",
  "delete_elements",
  "duplicate_elements",
  "group_elements",
  "ungroup",
  "set_roles",
  "arrange",
  "set_text",
  "rewrite_text",
  "translate_text",
  "set_style",
  "apply_brand",
  "add_page",
  "delete_page",
  "reorder_pages",
  "resize_page",
  "generate_image",
  "generate_svg",
  "remove_background",
  "inpaint",
  "outpaint",
  "upscale",
  "mockup",
  "trace_to_vector",
  "search_stock",
  "search_icons",
  "search_templates",
  "apply_template",
  "critique",
  "plan",
  "ask_user",
  "run_workflow",
  "finish",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const READ_ONLY_TOOLS: readonly ToolName[] = [
  "read_design",
  "read_selection",
  "render_preview",
  "query_elements",
  "critique",
  "plan",
  "ask_user",
  "finish",
  "search_templates",
];

const MEDIA_TOOLS: readonly ToolName[] = [
  "generate_image",
  "generate_svg",
  "remove_background",
  "inpaint",
  "outpaint",
  "upscale",
  "mockup",
  "trace_to_vector",
];

/** Tools allowed per agent mode (critique runs never edit). */
export function toolsForMode(mode: AgentMode): readonly ToolName[] {
  return mode === "critique" ? READ_ONLY_TOOLS : TOOL_NAMES;
}

function unavailable(ctx: ToolContext): Set<ToolName> {
  const out = new Set<ToolName>();
  if (!ctx.media) for (const t of MEDIA_TOOLS) out.add(t);
  if (!ctx.search?.stock) out.add("search_stock");
  if (!ctx.search?.icons) out.add("search_icons");
  if (!ctx.search?.templates) {
    out.add("search_templates");
    out.add("apply_template");
  }
  if (!ctx.workflows) out.add("run_workflow");
  if (!ctx.models?.copy) out.add("rewrite_text");
  if (!ctx.models?.translate) out.add("translate_text");
  if (!ctx.host.brand) out.add("apply_brand");
  return out;
}

export interface CreateToolsOptions {
  /** Tool allowlist for this run (default: every tool allowed by the mode). */
  allow?: readonly ToolName[];
}

export function createDesignTools(ctx: ToolContext, options: CreateToolsOptions = {}): ToolSet {
  const all: Record<string, ToolSet[string]> = {
    ...readTools(ctx),
    ...editTools(ctx),
    ...arrangeTools(ctx),
    ...textTools(ctx),
    ...pageTools(ctx),
    ...assetTools(ctx),
    ...searchTools(ctx),
    ...critiqueTools(ctx),
    ...controlTools(ctx),
  };
  // An allowlist narrows the mode's tools; it can never widen them (a critique run must not edit).
  const modeTools = new Set<ToolName>(toolsForMode(ctx.run.mode));
  const allowed = new Set((options.allow ?? [...modeTools]).filter((n) => modeTools.has(n)));
  const missing = unavailable(ctx);
  const out: ToolSet = {};
  for (const name of TOOL_NAMES) {
    if (allowed.has(name) && !missing.has(name) && all[name]) out[name] = all[name];
  }
  return out;
}

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
}

/**
 * JSON-schema descriptors of every tool (for the public Agent API and MCP server). Built from the same zod
 * schemas the agent uses; nothing is executed.
 */
export async function describeDesignTools(): Promise<ToolDescriptor[]> {
  const schemaOnly = new Proxy({} as ToolContext["host"], {
    get() {
      throw new Error("schema-only tool context");
    },
  });
  const ctx: ToolContext = {
    host: schemaOnly,
    run: createRunState("schema", "edit"),
    emit: () => undefined,
  };
  const all: Record<string, ToolSet[string]> = {
    ...readTools(ctx),
    ...editTools(ctx),
    ...arrangeTools(ctx),
    ...textTools(ctx),
    ...pageTools(ctx),
    ...assetTools(ctx),
    ...searchTools(ctx),
    ...critiqueTools(ctx),
    ...controlTools(ctx),
  };
  return Promise.all(
    TOOL_NAMES.map(async (name) => {
      const t = all[name] as ToolSet[string];
      const schema = asSchema(t.inputSchema as Parameters<typeof asSchema>[0]);
      return {
        name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: await schema.jsonSchema,
        readOnly: READ_ONLY_TOOLS.includes(name),
      };
    }),
  );
}

export * from "./types";
