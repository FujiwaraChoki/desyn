import { z } from "zod";
import { type ApiScope, DeletedSchema } from "./common";
import * as R from "./resources";

// The route table of the Agent API v1. Convex dispatches requests with it, the OpenAPI document is generated
// from it and the SDK client is typed by it. Paths are relative to /api/v1.

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type ResponseKind =
  | { type: "json"; schema: z.ZodType }
  | { type: "binary"; contentTypes: string[]; description: string }
  | { type: "events"; schema: z.ZodType; description: string };

export interface RouteDef {
  id: string;
  method: HttpMethod;
  /** OpenAPI-style template, e.g. "/designs/{designId}". */
  path: string;
  tag: string;
  summary: string;
  description: string;
  /** Every listed scope is required. Empty: any valid key. */
  scopes: ApiScope[];
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  response: ResponseKind;
  status: number;
  /** Accepts an `Idempotency-Key` header (replays return the stored response). */
  idempotent?: boolean;
  /** Rate-limit cost in tokens (default 1). */
  cost?: number;
  /** Served without an API key. */
  public?: boolean;
}

const json = (schema: z.ZodType): ResponseKind => ({ type: "json", schema });

// Path ids are opaque; unknown or malformed ones are 404 (resolved by the backend), never 400.
const pathId = (what: string) => z.string().min(1).max(128).describe(`${what} id.`);
const designParams = z.object({ designId: pathId("Design") });
const assetParams = z.object({ assetId: pathId("Asset") });
const exportParams = z.object({ exportId: pathId("Export") });
const brandParams = z.object({ brandKitId: pathId("Brand kit") });
const runParams = z.object({ runId: z.string().min(1).max(128).describe("Run id.") });
const workflowParams = z.object({
  workflowId: z.string().min(1).max(128).describe("Workflow run id."),
});
const templateParams = z.object({
  template: z.string().min(1).max(120).describe("Template id or slug."),
});

export const ROUTES = [
  // --- account -------------------------------------------------------------------------------------------------
  {
    id: "getMe",
    method: "GET",
    path: "/me",
    tag: "Account",
    summary: "Get the key's member",
    description: "The member the API key acts as, its plan, workspace, role and effective scopes.",
    scopes: [],
    response: json(R.MeSchema),
    status: 200,
  },
  {
    id: "listWorkspaces",
    method: "GET",
    path: "/workspaces",
    tag: "Account",
    summary: "List workspaces",
    description:
      "Workspaces the member belongs to. API calls are always scoped to the key's own workspace (`current`).",
    scopes: [],
    response: json(R.WorkspaceListSchema),
    status: 200,
  },
  {
    id: "getCredits",
    method: "GET",
    path: "/credits",
    tag: "Account",
    summary: "Get the credit balance",
    description:
      "AI credits for the current period: grant, used, reserved by running jobs, overage (never billed) and whether requests are soft-throttled. `granted` / `remaining` are null when unlimited.",
    scopes: [],
    response: json(R.CreditsSchema),
    status: 200,
  },
  {
    id: "getUsage",
    method: "GET",
    path: "/usage",
    tag: "Account",
    summary: "Get usage",
    description:
      "Usage counters against the plan limits, credits, fair-use caps and the key's API rate limit.",
    scopes: [],
    response: json(R.UsageSchema),
    status: 200,
  },
  // --- designs -------------------------------------------------------------------------------------------------
  {
    id: "listDesigns",
    method: "GET",
    path: "/designs",
    tag: "Designs",
    summary: "List designs",
    description: "Designs of the key's workspace, most recently updated first.",
    scopes: ["designs:read"],
    query: R.DesignListQuerySchema,
    response: json(R.DesignListSchema),
    status: 200,
  },
  {
    id: "createDesign",
    method: "POST",
    path: "/designs",
    tag: "Designs",
    summary: "Create a design",
    description:
      "Creates a design from a page preset, a custom size or a template. To have the AI build it, create it and start an agent run.",
    scopes: ["designs:write"],
    body: R.CreateDesignBodySchema,
    response: json(R.CreatedDesignSchema),
    status: 201,
    idempotent: true,
    cost: 2,
  },
  {
    id: "getDesign",
    method: "GET",
    path: "/designs/{designId}",
    tag: "Designs",
    summary: "Get a design",
    description: "Metadata of one design. Load the document for its content.",
    scopes: ["designs:read"],
    params: designParams,
    response: json(R.DesignSummarySchema),
    status: 200,
  },
  {
    id: "updateDesign",
    method: "PATCH",
    path: "/designs/{designId}",
    tag: "Designs",
    summary: "Rename or move a design",
    description:
      "Change the name (committed through the transaction log, so open editors update live) and/or the folder.",
    scopes: ["designs:write"],
    params: designParams,
    body: R.UpdateDesignBodySchema,
    response: json(R.DesignSummarySchema),
    status: 200,
  },
  {
    id: "archiveDesign",
    method: "POST",
    path: "/designs/{designId}/archive",
    tag: "Designs",
    summary: "Archive a design",
    description: "Hides an active design from lists without deleting it.",
    scopes: ["designs:write"],
    params: designParams,
    response: json(R.DesignSummarySchema),
    status: 200,
  },
  {
    id: "restoreDesign",
    method: "POST",
    path: "/designs/{designId}/restore",
    tag: "Designs",
    summary: "Restore a design",
    description: "Restores an archived or trashed design.",
    scopes: ["designs:write"],
    params: designParams,
    response: json(R.DesignSummarySchema),
    status: 200,
  },
  {
    id: "deleteDesign",
    method: "DELETE",
    path: "/designs/{designId}",
    tag: "Designs",
    summary: "Delete a design",
    description:
      "Moves the design to the trash (purged after 30 days). With `permanent=true` on a design that is already in the trash, deletes it with its history now.",
    scopes: ["designs:write"],
    params: designParams,
    query: R.DeleteDesignQuerySchema,
    response: json(R.DeletedDesignSchema),
    status: 200,
  },
  {
    id: "getDocument",
    method: "GET",
    path: "/designs/{designId}/document",
    tag: "Document",
    summary: "Load the document",
    description:
      "The full `Design` (DOCUMENT_MODEL.md) and the seq it reflects. Asset `url`s are filled with signed URLs; never commit them back.",
    scopes: ["designs:read"],
    params: designParams,
    query: R.DocumentQuerySchema,
    response: json(R.DocumentSchema),
    status: 200,
    cost: 3,
  },
  {
    id: "commitTransaction",
    method: "POST",
    path: "/designs/{designId}/transactions",
    tag: "Document",
    summary: "Commit a transaction",
    description:
      "Applies ops to the current server state (last writer wins per property). Ops that no longer apply are dropped and reported, never fatal. Idempotent on `tx.id`; with an `Idempotency-Key` header and no `tx.id`, the id is derived from the key.",
    scopes: ["designs:write"],
    params: designParams,
    body: R.CommitBodySchema,
    response: json(R.CommitResultSchema),
    status: 200,
    idempotent: true,
    cost: 2,
  },
  {
    id: "listTransactions",
    method: "GET",
    path: "/designs/{designId}/transactions",
    tag: "Document",
    summary: "List transactions since a seq",
    description:
      "Accepted transactions after `since`, oldest first. Poll it to follow a design. When `reload` is true the log was compacted: load the document again.",
    scopes: ["designs:read"],
    params: designParams,
    query: R.TransactionsQuerySchema,
    response: json(R.TransactionListSchema),
    status: 200,
  },
  {
    id: "describeDesign",
    method: "GET",
    path: "/designs/{designId}/describe",
    tag: "Document",
    summary: "Describe a page",
    description:
      "The semantic description the AI reads (DOCUMENT_MODEL §7): tree in page coordinates, palette, fonts, typography, grid, hierarchy and lint issues. Computed by the render worker.",
    scopes: ["designs:read"],
    params: designParams,
    query: R.DescribeQuerySchema,
    response: json(R.DescriptionSchema),
    status: 200,
    cost: 5,
  },
  {
    id: "renderPreview",
    method: "POST",
    path: "/designs/{designId}/preview",
    tag: "Document",
    summary: "Render a preview",
    description:
      "Renders one page (or a region) synchronously through the render worker and returns the image bytes. The `x-desyn-seq` header names the seq rendered. Use exports for print-quality files.",
    scopes: ["designs:read"],
    params: designParams,
    body: R.PreviewBodySchema,
    response: {
      type: "binary",
      contentTypes: ["image/png", "image/webp", "image/jpeg"],
      description: "The rendered image.",
    },
    status: 200,
    cost: 10,
  },
  {
    id: "applyBrand",
    method: "POST",
    path: "/designs/{designId}/apply-brand",
    tag: "Document",
    summary: "Apply a brand kit",
    description:
      "Maps the design's colors, fonts and logos onto a brand kit without moving the layout, repairs text contrast and commits the result as one transaction.",
    scopes: ["designs:write", "brand:read"],
    params: designParams,
    body: R.ApplyBrandBodySchema,
    response: json(R.ApplyBrandResultSchema),
    status: 200,
    idempotent: true,
    cost: 5,
  },
  // --- exports -------------------------------------------------------------------------------------------------
  {
    id: "requestExport",
    method: "POST",
    path: "/designs/{designId}/exports",
    tag: "Exports",
    summary: "Request an export",
    description:
      "Queues an export job on the render worker. Poll the export until `status` is `ready`. Formats are plan features (`export.*`).",
    scopes: ["exports:write"],
    params: designParams,
    body: R.ExportBodySchema,
    response: json(R.ExportSchema),
    status: 202,
    idempotent: true,
    cost: 10,
  },
  {
    id: "getExport",
    method: "GET",
    path: "/exports/{exportId}",
    tag: "Exports",
    summary: "Get an export",
    description: "Status of an export job, with signed download URLs once ready.",
    scopes: ["exports:write"],
    params: exportParams,
    response: json(R.ExportSchema),
    status: 200,
  },
  // --- assets --------------------------------------------------------------------------------------------------
  {
    id: "listAssets",
    method: "GET",
    path: "/assets",
    tag: "Assets",
    summary: "List assets",
    description: "Ready assets of the workspace, newest first.",
    scopes: ["assets:read"],
    query: R.AssetListQuerySchema,
    response: json(R.AssetListSchema),
    status: 200,
  },
  {
    id: "requestUpload",
    method: "POST",
    path: "/assets/uploads",
    tag: "Assets",
    summary: "Request an upload",
    description:
      "Validates type and size against the plan and returns a presigned PUT URL. Upload the bytes with exactly the returned headers within 15 minutes, then finalize.",
    scopes: ["assets:write"],
    body: R.UploadRequestBodySchema,
    response: json(R.UploadTicketSchema),
    status: 201,
    idempotent: true,
    cost: 2,
  },
  {
    id: "finalizeUpload",
    method: "POST",
    path: "/assets/{assetId}/finalize",
    tag: "Assets",
    summary: "Finalize an upload",
    description:
      "Verifies the uploaded object (size, type, magic bytes), reads dimensions, sanitizes SVG and dedupes. Returns the (possibly deduplicated) asset.",
    scopes: ["assets:write"],
    params: assetParams,
    body: R.FinalizeBodySchema,
    response: json(R.AssetSchema),
    status: 200,
    cost: 3,
  },
  {
    id: "getAsset",
    method: "GET",
    path: "/assets/{assetId}",
    tag: "Assets",
    summary: "Get an asset",
    description: "Metadata, a signed GET URL and a ready-made AssetRef.",
    scopes: ["assets:read"],
    params: assetParams,
    response: json(R.AssetSchema),
    status: 200,
  },
  {
    id: "renameAsset",
    method: "PATCH",
    path: "/assets/{assetId}",
    tag: "Assets",
    summary: "Rename an asset",
    description: "Change the display name in the library.",
    scopes: ["assets:write"],
    params: assetParams,
    body: R.RenameBodySchema,
    response: json(R.AssetSchema),
    status: 200,
  },
  {
    id: "deleteAsset",
    method: "DELETE",
    path: "/assets/{assetId}",
    tag: "Assets",
    summary: "Delete an asset",
    description:
      "Removes it from the library. Designs that use it keep working; the bytes go once nothing references them.",
    scopes: ["assets:write"],
    params: assetParams,
    response: json(DeletedSchema),
    status: 200,
  },
  // --- templates -----------------------------------------------------------------------------------------------
  {
    id: "searchTemplates",
    method: "GET",
    path: "/templates",
    tag: "Templates",
    summary: "Search templates",
    description:
      "Full-text search (`q`) or browse by kind / category. Premium templates need Pro to instantiate.",
    scopes: ["templates:read"],
    query: R.TemplateSearchQuerySchema,
    response: json(R.TemplateListSchema),
    status: 200,
  },
  {
    id: "getTemplate",
    method: "GET",
    path: "/templates/{template}",
    tag: "Templates",
    summary: "Get a template",
    description: "Template metadata including its slots (layers meant to be replaced).",
    scopes: ["templates:read"],
    params: templateParams,
    response: json(R.TemplateDetailSchema),
    status: 200,
    cost: 2,
  },
  {
    id: "instantiateTemplate",
    method: "POST",
    path: "/templates/{template}/instantiate",
    tag: "Templates",
    summary: "Instantiate a template",
    description:
      "Creates a design from the template with fresh ids, optionally fills slots (text, or images by asset) and applies a brand kit.",
    scopes: ["designs:write", "templates:read"],
    params: templateParams,
    body: R.InstantiateBodySchema,
    response: json(R.InstantiatedSchema),
    status: 201,
    idempotent: true,
    cost: 5,
  },
  // --- brand kits ----------------------------------------------------------------------------------------------
  {
    id: "listBrandKits",
    method: "GET",
    path: "/brand-kits",
    tag: "Brand kits",
    summary: "List brand kits",
    description: "Brand kits of the workspace (the default kit first).",
    scopes: ["brand:read"],
    response: json(R.BrandKitListSchema),
    status: 200,
  },
  {
    id: "createBrandKit",
    method: "POST",
    path: "/brand-kits",
    tag: "Brand kits",
    summary: "Create a brand kit",
    description: "Requires the `brandKit` feature and counts toward the `brandKits` limit.",
    scopes: ["brand:write"],
    body: R.CreateBrandKitBodySchema,
    response: json(R.BrandKitSchema),
    status: 201,
    idempotent: true,
  },
  {
    id: "getBrandKit",
    method: "GET",
    path: "/brand-kits/{brandKitId}",
    tag: "Brand kits",
    summary: "Get a brand kit",
    description: "One brand kit with signed logo / font URLs.",
    scopes: ["brand:read"],
    params: brandParams,
    response: json(R.BrandKitSchema),
    status: 200,
  },
  {
    id: "updateBrandKit",
    method: "PATCH",
    path: "/brand-kits/{brandKitId}",
    tag: "Brand kits",
    summary: "Update a brand kit",
    description:
      "Replace any field. Designs that follow the kit are not changed until the kit is applied again.",
    scopes: ["brand:write"],
    params: brandParams,
    body: R.UpdateBrandKitBodySchema,
    response: json(R.BrandKitSchema),
    status: 200,
  },
  {
    id: "deleteBrandKit",
    method: "DELETE",
    path: "/brand-kits/{brandKitId}",
    tag: "Brand kits",
    summary: "Delete a brand kit",
    description: "Designs keep their current styling.",
    scopes: ["brand:write"],
    params: brandParams,
    response: json(DeletedSchema),
    status: 200,
  },
  {
    id: "listFolders",
    method: "GET",
    path: "/folders",
    tag: "Designs",
    summary: "List folders",
    description: "Folders of the workspace as a flat list with `parentId`.",
    scopes: ["designs:read"],
    response: json(R.FolderListSchema),
    status: 200,
  },
  // --- AI ------------------------------------------------------------------------------------------------------
  {
    id: "startAgentRun",
    method: "POST",
    path: "/designs/{designId}/agent-runs",
    tag: "AI",
    summary: "Start an agent run",
    description:
      'Starts the server-side agent on a design: it reads the design, plans, edits through transactions (`source: "ai"`, one undo group) and finishes with a summary. Credits are reserved up front and settled when the run ends; AI fair-use caps apply.',
    scopes: ["ai:run"],
    params: designParams,
    body: R.StartRunBodySchema,
    response: json(R.AiRunSchema),
    status: 202,
    idempotent: true,
    cost: 5,
  },
  {
    id: "getAgentRun",
    method: "GET",
    path: "/agent-runs/{runId}",
    tag: "AI",
    summary: "Get a run",
    description: "Status, pending question, credits and the result of an agent or asset run.",
    scopes: ["ai:run"],
    params: runParams,
    response: json(R.AiRunSchema),
    status: 200,
  },
  {
    id: "listAgentRunEvents",
    method: "GET",
    path: "/agent-runs/{runId}/events",
    tag: "AI",
    summary: "Follow run events",
    description:
      "Events of a run after a cursor. With `Accept: text/event-stream` the response is a Server-Sent Events stream (`id` = event index, resume with `Last-Event-ID`) that ends with a `stream-end` event when the run finishes, or after about a minute without one (reconnect with `Last-Event-ID`); a failure while streaming is a `stream-error` event with `{ code, message }`. Every other event name is the AgentEvent `type`, including a run's own `error` events; otherwise JSON, optionally long-polling with `wait`.",
    scopes: ["ai:run"],
    params: runParams,
    query: R.RunEventsQuerySchema,
    response: {
      type: "events",
      schema: R.AiRunEventListSchema,
      description: "Run events (JSON page, or an SSE stream of AiRunEvent).",
    },
    status: 200,
  },
  {
    id: "answerAgentRun",
    method: "POST",
    path: "/agent-runs/{runId}/answer",
    tag: "AI",
    summary: "Answer a question",
    description: "Resumes a run that paused with a question (status needs-input).",
    scopes: ["ai:run"],
    params: runParams,
    body: R.AnswerBodySchema,
    response: json(R.AiRunSchema),
    status: 200,
    idempotent: true,
  },
  {
    id: "cancelAgentRun",
    method: "POST",
    path: "/agent-runs/{runId}/cancel",
    tag: "AI",
    summary: "Cancel a run",
    description:
      "Stops the run after the current step. Committed edits stay (undo them as one step); unused reserved credits are returned.",
    scopes: ["ai:run"],
    params: runParams,
    response: json(R.AiRunSchema),
    status: 200,
  },
  {
    id: "generateAsset",
    method: "POST",
    path: "/assets/generate",
    tag: "AI",
    summary: "Generate or transform an asset",
    description:
      'Runs one asset tool (image, svg, remove-background, inpaint, outpaint, upscale, mockup, trace) as a run; when it completes, `result.assetId` / `result.refId` name the new asset (`source: "ai"`).',
    scopes: ["ai:run", "assets:write"],
    body: R.GenerateAssetBodySchema,
    response: json(R.AiRunSchema),
    status: 202,
    idempotent: true,
    cost: 5,
  },
  {
    id: "startWorkflow",
    method: "POST",
    path: "/workflows",
    tag: "AI",
    summary: "Start a workflow",
    description:
      "Starts a durable multi-step workflow: campaign, variants, resize, localize, bulk or exportBundle. Each step bills credits as it completes; outputs are new designs.",
    scopes: ["ai:run", "designs:write"],
    body: R.StartWorkflowBodySchema,
    response: json(R.WorkflowSchema),
    status: 202,
    idempotent: true,
    cost: 5,
  },
  {
    id: "getWorkflow",
    method: "GET",
    path: "/workflows/{workflowId}",
    tag: "AI",
    summary: "Get a workflow",
    description: "Progress and outputs of a workflow run.",
    scopes: ["ai:run"],
    params: workflowParams,
    response: json(R.WorkflowSchema),
    status: 200,
  },
  {
    id: "listModels",
    method: "GET",
    path: "/ai/models",
    tag: "AI",
    summary: "List models",
    description:
      "Models available to the member per AI task (live provider catalogs, BYOK keys and local endpoints) with the routing default marked.",
    scopes: ["ai:run"],
    query: R.ModelsQuerySchema,
    response: json(R.ModelListSchema),
    status: 200,
    cost: 2,
  },
] as const satisfies readonly RouteDef[];

export type RouteId = (typeof ROUTES)[number]["id"];
