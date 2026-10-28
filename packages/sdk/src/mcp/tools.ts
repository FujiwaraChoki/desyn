import { DesignKindSchema, type Op, UnitSchema } from "@desyn/schema";
import { z } from "zod";
import { type AiRun, type DesynClient, isTerminalRunStatus } from "../client";
import { ExportFormatSchema, WorkflowTypeSchema } from "../contract/resources";
import { DesynApiError } from "../errors";
import { mimeFromName } from "../mime";
import { NodeInputError, normalizeOps } from "../transactions";
import {
  type CallToolResult,
  type ContentBlock,
  ErrorCode,
  fromBase64,
  McpError,
  type ToolAnnotations,
  type ToolDescriptor,
  toBase64,
} from "./protocol";

// MCP tools mapped onto the Agent API. Each tool validates its arguments with zod, calls the typed client and
// returns text (JSON) plus structured content; images come back as image content blocks. API failures are
// reported as tool errors (`isError: true`) so the model can correct itself.

export interface ToolContext {
  client: DesynClient;
  signal?: AbortSignal;
  /** Local filesystem access (stdio server only). */
  readFile?: (path: string) => Promise<Uint8Array>;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** Only offered when the context provides `readFile` (stdio). */
  local?: boolean;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<CallToolResult>;
}

function tool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** JSON text + structured content. */
export function jsonResult(value: unknown, summary?: string): CallToolResult {
  const content: ContentBlock[] = [];
  if (summary) content.push({ type: "text", text: summary });
  content.push({ type: "text", text: JSON.stringify(value, null, 2) });
  const structured =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return { content, structuredContent: structured };
}

export function errorResult(message: string, details?: Record<string, unknown>): CallToolResult {
  const text =
    details && Object.keys(details).length > 0
      ? `${message}\n${JSON.stringify(details, null, 2)}`
      : message;
  return { content: [{ type: "text", text }], isError: true };
}

const designId = z.string().min(1).describe("Design id (from list_designs / create_design).");
const pageId = z.string().optional().describe("Page node id; default: the first page.");

const OPS_GUIDE = `Ops follow the Desyn document model (DOCUMENT_MODEL.md §5):
- {"op":"create","parent":"<pageOrContainerId>","index"?:n,"node":{...}}: "node" is a friendly node: "type" plus any fields; missing fields get defaults; nested "children" create a subtree. Shorthands: text nodes take "text","fontFamily","fontSize","fontWeight","italic","color","letterSpacing","align","lineHeight"; shapes take "fill":"#rrggbb". Full nodes can be sent as "nodes":[root, ...descendants] instead.
- {"op":"update","id":"<nodeId>","set":{...},"unset"?:[...]}: shallow property merge (nested values replaced whole).
- {"op":"patch","id":"<nodeId>","path":["style","fills",0,"color"],"value":"#ffb02e"}: deep set.
- {"op":"delete","id":"<nodeId>"} / {"op":"move","id":"<nodeId>","parent":"<id>","index"?:n}.
- {"op":"asset","set":{"<refId>": AssetRef}} (use "assetRef" from list_assets) / {"op":"styles","path":[...],"value":...} / {"op":"doc","set":{"name":...}}.
Geometry is in design pixels relative to the parent; colors are lowercase "#rrggbb" or "#rrggbbaa"; ids are 12 chars [a-z0-9] (generated when omitted). Ops that no longer apply are dropped and reported, never fatal.`;

export const TOOLS: ToolDef[] = [
  tool({
    name: "get_account",
    title: "Account",
    description:
      "Who the API key acts as (member, workspace, role, plan, scopes) and the AI credit balance. Call first to learn what is allowed.",
    input: z.object({}),
    annotations: READ,
    run: async (_args, { client, signal }) => {
      const opts = signal ? { signal } : undefined;
      const [me, credits] = await Promise.all([client.me(opts), client.credits(opts)]);
      return jsonResult({ ...me, credits });
    },
  }),
  tool({
    name: "list_designs",
    title: "List designs",
    description:
      "Designs of the workspace, most recently updated first. Use `search` to find one by name.",
    input: z.object({
      search: z.string().max(200).optional(),
      kind: DesignKindSchema.optional(),
      state: z.enum(["active", "archived", "trashed"]).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
      cursor: z.string().optional().describe("nextCursor of the previous call."),
    }),
    annotations: READ,
    run: async (args, { client, signal }) => {
      const page = await client.designs.list(args, signal ? { signal } : undefined);
      return jsonResult({
        items: page.items.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          state: d.state,
          pageCount: d.pageCount,
          width: d.width,
          height: d.height,
          seq: d.seq,
          updatedAt: new Date(d.updatedAt).toISOString(),
          thumbnailUrl: d.thumbnailUrl,
        })),
        nextCursor: page.nextCursor,
      });
    },
  }),
  tool({
    name: "create_design",
    title: "Create a design",
    description:
      "Create a design from a page preset (e.g. `instagram-post`), a custom size or a template id. Returns its id and `firstPageId` (the parent for new elements).",
    input: z.object({
      name: z.string().min(1).max(200).optional(),
      kind: DesignKindSchema.optional(),
      presetId: z.string().optional(),
      width: z
        .number()
        .min(1)
        .max(100_000)
        .optional()
        .describe("Custom first page width (design px); with height."),
      height: z.number().min(1).max(100_000).optional(),
      unit: UnitSchema.optional(),
      templateId: z.string().optional(),
    }),
    annotations: WRITE,
    run: async (args, { client, signal }) => {
      const created = await client.designs.create(args, signal ? { signal } : undefined);
      return jsonResult(
        created,
        `Created design ${created.id} (first page ${created.firstPageId}).`,
      );
    },
  }),
  tool({
    name: "update_design",
    title: "Rename or move a design",
    description: "Rename a design and/or move it to a folder (folderId null = workspace root).",
    input: z.object({
      designId,
      name: z.string().min(1).max(200).optional(),
      folderId: z.string().nullable().optional(),
    }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async ({ designId: id, ...rest }, { client, signal }) =>
      jsonResult(await client.designs.update(id, rest, signal ? { signal } : undefined)),
  }),
  tool({
    name: "delete_design",
    title: "Move a design to the trash",
    description: "Moves the design to the trash (restorable for 30 days in the app).",
    input: z.object({ designId }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async ({ designId: id }, { client, signal }) =>
      jsonResult(await client.designs.delete(id, {}, signal ? { signal } : undefined)),
  }),
  tool({
    name: "describe_design",
    title: "Describe a design",
    description:
      "The semantic description of a page: element tree in page coordinates with roles, text and fonts, palette, typography scale, alignment grid, visual hierarchy and lint issues (contrast, overflow, spacing…). The best way to understand a design before editing it.",
    input: z.object({
      designId,
      pageId,
      selection: z.array(z.string()).max(500).optional().describe("Node ids to mark as selected."),
      maxDepth: z.number().int().min(1).max(64).optional(),
    }),
    annotations: READ,
    run: async ({ designId: id, ...q }, { client, signal }) =>
      jsonResult(await client.designs.describe(id, q, signal ? { signal } : undefined)),
  }),
  tool({
    name: "get_document",
    title: "Read the document",
    description:
      "The raw Design document (all nodes with every property) and its `seq`. Prefer describe_design for understanding; use this when you need exact property values or ids, ideally with `pageId`.",
    input: z.object({ designId, pageId }),
    annotations: READ,
    run: async ({ designId: id, pageId: page }, { client, signal }) => {
      const doc = await client.designs.load(
        id,
        page ? { pageId: page } : {},
        signal ? { signal } : undefined,
      );
      return jsonResult(doc);
    },
  }),
  tool({
    name: "apply_operations",
    title: "Edit a design",
    description: `Apply ops to a design as one undoable transaction that collaborators see live. Returns the new seq, the applied ops and any dropped ops with reasons.\n\n${OPS_GUIDE}`,
    input: z.object({
      designId,
      label: z.string().max(200).optional().describe('History label, e.g. "Add pricing table".'),
      baseSeq: z.number().int().min(0).optional().describe("The seq your view is based on."),
      ops: z.array(z.record(z.string(), z.unknown())).min(1).max(2_000),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async ({ designId: id, label, baseSeq, ops }, { client, signal }) => {
      let normalized: Op[];
      try {
        normalized = normalizeOps(ops);
      } catch (err) {
        if (err instanceof NodeInputError) return errorResult(err.message);
        throw err;
      }
      const result = await client.designs.commit(
        id,
        {
          ...(baseSeq !== undefined ? { baseSeq } : {}),
          tx: {
            label: label ?? "MCP edit",
            ops: normalized,
            source: "ai",
            actor: { agent: "mcp" },
          },
        },
        signal ? { signal } : undefined,
      );
      const created = normalized.flatMap((op) =>
        op.op === "create" && op.nodes[0] ? [op.nodes[0].id] : [],
      );
      const summary =
        result.dropped.length > 0
          ? `Committed seq ${result.seq}; ${result.dropped.length} op(s) dropped: ${result.dropped.map((d) => `#${d.index} ${d.reason}`).join(", ")}.`
          : `Committed seq ${result.seq}; ${result.applied.length} op(s) applied.`;
      return jsonResult({ ...result, createdIds: created }, summary);
    },
  }),
  tool({
    name: "list_changes",
    title: "List recent changes",
    description:
      "Transactions committed after a seq (by anyone), oldest first. Use it to catch up with collaborators before editing; `reload: true` means load the document again.",
    input: z.object({
      designId,
      since: z.number().int().min(0),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    annotations: READ,
    run: async ({ designId: id, ...q }, { client, signal }) =>
      jsonResult(await client.designs.transactions(id, q, signal ? { signal } : undefined)),
  }),
  tool({
    name: "render_preview",
    title: "Render a preview",
    description:
      "Render a page (or a region in page coordinates) to an image you can look at. Use after larger edits to check the result.",
    input: z.object({
      designId,
      pageId,
      region: z
        .object({
          x: z.number(),
          y: z.number(),
          w: z.number().positive(),
          h: z.number().positive(),
        })
        .optional(),
      maxSize: z
        .number()
        .int()
        .min(64)
        .max(2048)
        .optional()
        .describe("Longest edge in px. Default 1024."),
      format: z.enum(["png", "webp", "jpeg"]).optional(),
    }),
    annotations: READ,
    run: async ({ designId: id, maxSize, ...rest }, { client, signal }) => {
      const out = await client.designs.preview(
        id,
        { ...rest, maxSize: maxSize ?? 1024 },
        signal ? { signal } : undefined,
      );
      return {
        content: [
          { type: "image", data: toBase64(out.bytes), mimeType: out.contentType },
          { type: "text", text: `Rendered page ${out.pageId ?? "(first)"} at seq ${out.seq}.` },
        ],
        structuredContent: {
          pageId: out.pageId,
          seq: out.seq,
          mimeType: out.contentType,
          bytes: out.bytes.length,
        },
      };
    },
  }),
  tool({
    name: "export_design",
    title: "Export a design",
    description:
      "Export pages to PNG, JPEG, WebP, SVG, PDF (print options), PPTX, GIF or MP4 via the render worker. Waits for the files by default and returns signed download URLs (valid 24 h).",
    input: z.object({
      designId,
      format: ExportFormatSchema,
      pages: z.union([z.literal("all"), z.array(z.string()).min(1)]).optional(),
      scale: z.number().min(0.1).max(8).optional(),
      quality: z.number().min(1).max(100).optional(),
      background: z.string().optional().describe('"#rrggbb" or "transparent".'),
      pdf: z.object({ bleed: z.boolean(), cropMarks: z.boolean(), cmyk: z.boolean() }).optional(),
      wait: z
        .boolean()
        .optional()
        .describe("Wait until the files are ready (default true, up to 5 minutes)."),
    }),
    annotations: { ...WRITE, openWorldHint: false },
    run: async ({ designId: id, wait, ...input }, { client, signal }) => {
      const job = await client.exports.request(id, input, signal ? { signal } : undefined);
      if (wait === false) return jsonResult(job, `Export ${job.id} is ${job.status}.`);
      const done = await client.exports.wait(job.id, {
        timeoutMs: 5 * 60_000,
        ...(signal ? { signal } : {}),
      });
      return jsonResult(done, `Export ${done.id} is ready: ${done.files.length} file(s).`);
    },
  }),
  tool({
    name: "list_assets",
    title: "List assets",
    description:
      "Uploaded and generated assets of the workspace. Each item has an `assetRef` to add to a design with an asset op before an image node uses its id.",
    input: z.object({
      kind: z.enum(["image", "svg", "font", "video", "audio", "lottie", "data"]).optional(),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }),
    annotations: READ,
    run: async (args, { client, signal }) =>
      jsonResult(await client.assets.list(args, signal ? { signal } : undefined)),
  }),
  tool({
    name: "upload_asset",
    title: "Upload an asset",
    description:
      "Upload a file given as base64 (images, SVG, fonts, video, audio; at most ~3 MB this way). Returns the ready asset with its `assetRef`.",
    input: z.object({
      name: z.string().min(1).max(200),
      mime: z.string().min(3).max(200),
      dataBase64: z.string().min(4).max(4_500_000),
    }),
    annotations: WRITE,
    run: async ({ name, mime, dataBase64 }, { client, signal }) => {
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(dataBase64);
      } catch {
        return errorResult("dataBase64 is not valid base64.");
      }
      const asset = await client.assets.upload(
        bytes,
        { name, mime },
        signal ? { signal } : undefined,
      );
      return jsonResult(asset, `Uploaded ${asset.name} (${asset.kind}, refId ${asset.refId}).`);
    },
  }),
  tool({
    name: "upload_file",
    title: "Upload a local file",
    description:
      "Upload a file from this computer by path (images, SVG, fonts, video, audio). Returns the ready asset with its `assetRef`.",
    input: z.object({
      path: z.string().min(1),
      mime: z.string().optional().describe("Detected from the extension when omitted."),
      name: z.string().optional(),
    }),
    annotations: { ...WRITE, openWorldHint: true },
    local: true,
    run: async ({ path, mime, name }, { client, signal, readFile }) => {
      if (!readFile) return errorResult("Local files are only available in the stdio server.");
      const bytes = await readFile(path);
      const fileName = name ?? path.split(/[\\/]/).pop() ?? "file";
      const type = mime ?? mimeFromName(fileName);
      if (!type) return errorResult(`Cannot tell the type of "${fileName}"; pass mime.`);
      const asset = await client.assets.upload(
        bytes,
        { name: fileName, mime: type },
        signal ? { signal } : undefined,
      );
      return jsonResult(asset, `Uploaded ${asset.name} (${asset.kind}, refId ${asset.refId}).`);
    },
  }),
  tool({
    name: "search_templates",
    title: "Search templates",
    description:
      "Search the template library by free text (e.g. `minimal bakery menu`) and/or kind / category.",
    input: z.object({
      query: z.string().max(200).optional(),
      kind: DesignKindSchema.optional(),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(60).optional(),
      cursor: z.string().optional(),
    }),
    annotations: READ,
    run: async ({ query, ...rest }, { client, signal }) => {
      const page = await client.templates.search(
        { ...rest, ...(query ? { q: query } : {}) },
        signal ? { signal } : undefined,
      );
      return jsonResult({
        items: page.items.map((t) => ({
          id: t.id,
          slug: t.slug,
          title: t.title,
          kind: t.kind,
          category: t.category,
          premium: t.premium,
          width: t.width,
          height: t.height,
          pageCount: t.pageCount,
          thumbnailUrl: t.thumbnails[0]?.url ?? null,
        })),
        nextCursor: page.nextCursor,
      });
    },
  }),
  tool({
    name: "get_template",
    title: "Get a template",
    description: "Template details including its slots (named layers meant to be replaced).",
    input: z.object({ template: z.string().min(1).describe("Template id or slug.") }),
    annotations: READ,
    run: async ({ template }, { client, signal }) =>
      jsonResult(await client.templates.get(template, signal ? { signal } : undefined)),
  }),
  tool({
    name: "instantiate_template",
    title: "Create a design from a template",
    description:
      "Create a design from a template, optionally filling slots (slot -> text, or slot -> asset id / refId for image slots) and applying a brand kit.",
    input: z.object({
      template: z.string().min(1).describe("Template id or slug."),
      name: z.string().min(1).max(200).optional(),
      slots: z.record(z.string(), z.string()).optional(),
      brandKitId: z.string().optional(),
    }),
    annotations: WRITE,
    run: async ({ template, ...input }, { client, signal }) => {
      const created = await client.templates.instantiate(
        template,
        input,
        signal ? { signal } : undefined,
      );
      return jsonResult(created, `Created design ${created.id} from the template.`);
    },
  }),
  tool({
    name: "list_brand_kits",
    title: "List brand kits",
    description:
      "Brand kits of the workspace (colors with roles, fonts, logos, voice, rules); the default first.",
    input: z.object({}),
    annotations: READ,
    run: async (_args, { client, signal }) =>
      jsonResult({ items: await client.brandKits.list(signal ? { signal } : undefined) }),
  }),
  tool({
    name: "apply_brand",
    title: "Apply a brand kit",
    description:
      "Restyle a design to a brand kit without moving the layout: maps colors onto the palette, fonts onto the kit fonts, swaps logos and repairs text contrast, as one undoable transaction.",
    input: z.object({
      designId,
      brandKitId: z
        .string()
        .optional()
        .describe("Default: the design's kit, then the workspace default."),
      pageIds: z.array(z.string()).optional(),
      colors: z.boolean().optional(),
      fonts: z.boolean().optional(),
      logo: z.enum(["replace", "add", "none"]).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async ({ designId: id, ...input }, { client, signal }) => {
      const result = await client.designs.applyBrand(id, input, signal ? { signal } : undefined);
      return jsonResult(
        result,
        result.commit
          ? `Applied the brand kit (seq ${result.commit.seq}): ${result.recolored} recolored, ${result.fontsChanged} fonts changed, ${result.logos.length} logos.`
          : "The design already matches the brand kit.",
      );
    },
  }),
  tool({
    name: "start_ai_run",
    title: "Run the Desyn agent",
    description:
      "Hand a goal to Desyn's own design agent (it edits the design with its full toolset: layout, typography, brand, image generation…). Waits up to `waitSeconds` (default 120) and returns the summary, or the question it asks (answer with answer_ai_run). Spends AI credits on the hosted plan.",
    input: z.object({
      designId,
      goal: z.string().min(1).max(8_000),
      mode: z.enum(["edit", "generate", "critique"]).optional(),
      pageId,
      selection: z.array(z.string()).optional(),
      waitSeconds: z.number().int().min(0).max(600).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async ({ designId: id, waitSeconds, ...input }, { client, signal }) => {
      const run = await client.agent.start(id, input, signal ? { signal } : undefined);
      return runResult(await settle(client, run, waitSeconds ?? 120, signal));
    },
  }),
  tool({
    name: "get_ai_run",
    title: "Get an AI run",
    description:
      "Status, question, credits and result of an agent / asset run; optionally waits for it.",
    input: z.object({
      runId: z.string().min(1),
      waitSeconds: z.number().int().min(0).max(600).optional(),
    }),
    annotations: READ,
    run: async ({ runId, waitSeconds }, { client, signal }) => {
      const run = await client.agent.get(runId, signal ? { signal } : undefined);
      return runResult(await settle(client, run, waitSeconds ?? 0, signal));
    },
  }),
  tool({
    name: "answer_ai_run",
    title: "Answer the agent",
    description: "Answer the question of a run waiting for input, then wait for it to continue.",
    input: z.object({
      runId: z.string().min(1),
      answer: z.string().min(1).max(4_000),
      waitSeconds: z.number().int().min(0).max(600).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async ({ runId, answer, waitSeconds }, { client, signal }) => {
      const run = await client.agent.answer(runId, answer, signal ? { signal } : undefined);
      return runResult(await settle(client, run, waitSeconds ?? 120, signal));
    },
  }),
  tool({
    name: "cancel_ai_run",
    title: "Cancel an AI run",
    description:
      "Stop a run after its current step. Edits already made stay (undo them in the editor).",
    input: z.object({ runId: z.string().min(1) }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async ({ runId }, { client, signal }) =>
      runResult(await client.agent.cancel(runId, signal ? { signal } : undefined)),
  }),
  tool({
    name: "generate_image",
    title: "Generate an image",
    description:
      "Generate an image (or SVG) asset from a prompt with the configured provider; waits for it and returns the asset with its `assetRef`, ready to place with apply_operations (add the assetRef with an asset op, then an image node with that assetId).",
    input: z.object({
      prompt: z.string().min(1).max(4_000),
      kind: z.enum(["image", "svg"]).optional().describe("Default image."),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      style: z.string().max(200).optional(),
      designId: z.string().optional().describe("Use this design's brand kit."),
      waitSeconds: z.number().int().min(0).max(600).optional(),
    }),
    annotations: { ...WRITE, openWorldHint: true },
    run: async ({ kind, waitSeconds, ...input }, { client, signal }) => {
      const run = await client.ai.generateAsset(
        { task: kind ?? "image", ...input },
        signal ? { signal } : undefined,
      );
      const settled = await settle(client, run, waitSeconds ?? 180, signal);
      const assetId = settled.result?.assetId;
      if (settled.status === "completed" && typeof assetId === "string") {
        const asset = await client.assets.get(assetId, signal ? { signal } : undefined);
        return jsonResult(
          { run: settled, asset },
          `Generated ${asset.name} (refId ${asset.refId}).`,
        );
      }
      return runResult(settled);
    },
  }),
  tool({
    name: "run_workflow",
    title: "Start a workflow",
    description:
      "Start a multi-step workflow: campaign (brief -> designs), variants (A/B), resize (formats), localize (languages, RTL aware), bulk (CSV merge) or exportBundle. Returns its id; follow it with get_workflow.",
    input: z.object({
      type: WorkflowTypeSchema,
      designId: z.string().optional(),
      input: z.record(z.string(), z.unknown()),
    }),
    annotations: { ...WRITE, openWorldHint: true },
    run: async (args, { client, signal }) => {
      const wf = await client.workflows.start(args, signal ? { signal } : undefined);
      return jsonResult(wf, `Workflow ${wf.id} is ${wf.status}.`);
    },
  }),
  tool({
    name: "get_workflow",
    title: "Get a workflow",
    description: "Progress and outputs (new designs) of a workflow.",
    input: z.object({ workflowId: z.string().min(1) }),
    annotations: READ,
    run: async ({ workflowId }, { client, signal }) =>
      jsonResult(await client.workflows.get(workflowId, signal ? { signal } : undefined)),
  }),
];

/** Wait (up to `seconds`) until a run finishes or asks a question. */
async function settle(
  client: DesynClient,
  run: AiRun,
  seconds: number,
  signal?: AbortSignal,
): Promise<AiRun> {
  if (seconds <= 0 || isTerminalRunStatus(run.status) || run.status === "needs-input") return run;
  try {
    return await client.agent.wait(run.id, {
      timeoutMs: seconds * 1000,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DesynApiError && err.code === "TIMEOUT")
      return await client.agent.get(run.id);
    throw err;
  }
}

function runResult(run: AiRun): CallToolResult {
  const summary =
    run.status === "needs-input" && run.question
      ? `The run asks: ${run.question.question}${run.question.options.length > 0 ? ` (options: ${run.question.options.join(" / ")})` : ""}. Answer with answer_ai_run.`
      : isTerminalRunStatus(run.status)
        ? `Run ${run.id} ${run.status}${typeof run.result?.summary === "string" ? `: ${run.result.summary}` : run.error ? `: ${run.error}` : "."}`
        : `Run ${run.id} is ${run.status}; check again with get_ai_run.`;
  return jsonResult(run, summary);
}

/** JSON Schema of a tool's input (MCP requires an object schema). */
export function toolDescriptor(def: ToolDef): ToolDescriptor {
  const { $schema: _s, ...schema } = z.toJSONSchema(def.input, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: { ...schema, type: "object" } as ToolDescriptor["inputSchema"],
    annotations: { title: def.title, ...def.annotations },
  };
}

/** Run a tool: argument errors and API errors become tool errors the model can read. */
export async function callTool(
  tools: readonly ToolDef[],
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const def = tools.find((t) => t.name === name);
  if (!def) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments for ${name}.`, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    });
  }
  try {
    return await def.run(parsed.data, ctx);
  } catch (err) {
    if (err instanceof DesynApiError) {
      return errorResult(`${err.code}: ${err.message}`, err.details);
    }
    throw err;
  }
}
