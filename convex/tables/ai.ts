import { defineTable } from "convex/server";
import { v } from "convex/values";

// AI backend tables (owned by the ai-backend agent, SPEC §6/§7). Run state lives in `aiRuns`, the streamed
// AgentEvents in `aiRunEvents` (reactive for the editor's AI dock and the Agent API), durable workflows in
// `aiWorkflows`, generated media provenance in `aiAssets` and the cached live model catalogs in
// `aiModelCatalog`. Per-task model choices and BYOK keys stay in `profiles.aiSettings` (accounts agent).

/** Run status, aligned with @desyn/ai RunStatus and the Agent API contract (`RUN_STATUSES`). */
export const aiRunStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("needs-input"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("budget-exceeded"),
  v.literal("step-limit"),
  v.literal("failed"),
);

export const aiRunKindValidator = v.union(
  v.literal("agent"),
  v.literal("asset"),
  v.literal("workflow"),
);

export const aiBillingValidator = v.union(
  v.literal("platform"),
  v.literal("byok"),
  v.literal("local"),
);

export const aiWorkflowStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const aiWorkflowTypeValidator = v.union(
  v.literal("campaign"),
  v.literal("variants"),
  v.literal("resize"),
  v.literal("localize"),
  v.literal("bulk"),
  v.literal("exportBundle"),
);

/** The credit reservation currently held by a run or workflow step (idempotent by refId). */
const reservationValidator = v.object({
  refId: v.string(),
  amount: v.number(),
  /** Metered credits already counted when this reservation was taken (settlement charges the difference). */
  usedAtStart: v.number(),
});

export const aiTables = {
  aiRuns: defineTable({
    kind: aiRunKindValidator,
    userId: v.string(),
    workspaceId: v.id("workspaces"),
    designId: v.optional(v.id("designs")),
    /** Agent mode (edit | generate | critique), media task (image, svg, …) or workflow type. */
    mode: v.string(),
    /** The user's request (truncated to 8000 characters). */
    goal: v.string(),
    status: aiRunStatusValidator,
    /** Set by cancelRun; the running action notices it between stream parts and stops. */
    cancelRequested: v.optional(v.boolean()),
    via: v.union(v.literal("app"), v.literal("api"), v.literal("workflow")),
    /** Idempotency for starts (Agent API Idempotency-Key, `${keyId}:${key}`). */
    requestKey: v.optional(v.string()),
    pageId: v.optional(v.string()),
    selection: v.optional(v.array(v.string())),
    /** Asset ids (Convex) attached to the goal. */
    attachments: v.optional(v.array(v.id("assets"))),
    /** Earlier run whose conversation this run continues. */
    previousRunId: v.optional(v.id("aiRuns")),
    /** "provider:model" override for the agent route. */
    modelOverride: v.optional(v.string()),
    /** Resolved agent model label ("provider:model"), known once the run starts. */
    model: v.optional(v.string()),
    billing: v.optional(aiBillingValidator),
    maxSteps: v.number(),
    /** Hard credit cap for the whole run (null = the reservation estimate). */
    maxCredits: v.optional(v.number()),
    steps: v.number(),
    /** Scheduled chunk counter; a chunk only runs when its number matches (stale schedules are ignored). */
    chunk: v.number(),
    /** Lease of the running chunk; an expired lease means the action died and the reaper resumes the run. */
    leaseUntil: v.optional(v.number()),
    /** Chunk restarts after crashes (the reaper fails the run after a few). */
    restarts: v.number(),
    /** Input of asset runs (JSON; options of the media task). */
    input: v.optional(v.string()),
    /** Conversation so far (JSON in file storage), for chunk continuation and follow-up runs. */
    historyId: v.optional(v.id("_storage")),
    question: v.optional(
      v.object({
        question: v.string(),
        options: v.array(v.string()),
        callId: v.optional(v.string()),
      }),
    ),
    /** Answer to resume a run waiting for input; consumed by the next chunk. */
    answer: v.optional(v.string()),
    reservation: v.optional(reservationValidator),
    /** Credits metered by the run (agent turns + media), across chunks. */
    creditsUsed: v.number(),
    /** Credits actually charged by the ledger (settled segments). */
    creditsCharged: v.number(),
    segments: v.number(),
    usage: v.optional(v.object({ inputTokens: v.number(), outputTokens: v.number() })),
    costUsd: v.optional(v.number()),
    transactions: v.number(),
    /** Run result: { summary, changes, followUps, assetId, refId, … } (plain JSON values). */
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    /** Next event sequence number (events are 0-based). */
    eventCount: v.number(),
    workflowId: v.optional(v.id("aiWorkflows")),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    /** Retention stage of a finished run: 0 kept, 1 conversation removed, 2 event log removed. */
    retention: v.optional(v.number()),
  })
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_design_created", ["designId", "createdAt"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_requestKey", ["requestKey"])
    .index("by_retention_finished", ["retention", "finishedAt"]),

  aiRunEvents: defineTable({
    runId: v.id("aiRuns"),
    seq: v.number(),
    type: v.string(),
    /** Compact JSON of the AgentEvent (without runId / type; long strings truncated, previews by reference). */
    payload: v.string(),
    ts: v.number(),
  }).index("by_run_seq", ["runId", "seq"]),

  aiWorkflows: defineTable({
    type: aiWorkflowTypeValidator,
    userId: v.string(),
    workspaceId: v.id("workspaces"),
    designId: v.optional(v.id("designs")),
    status: aiWorkflowStatusValidator,
    via: v.union(v.literal("app"), v.literal("api"), v.literal("agent")),
    requestKey: v.optional(v.string()),
    /** Companion run (kind "workflow") whose event log streams progress. */
    runId: v.id("aiRuns"),
    /** @desyn/ai WorkflowState snapshot (JSON); large states live in file storage instead. */
    state: v.optional(v.string()),
    stateId: v.optional(v.id("_storage")),
    progress: v.object({ done: v.number(), total: v.number() }),
    outputs: v.array(v.any()),
    creditsEstimated: v.number(),
    creditsUsed: v.number(),
    creditsCharged: v.number(),
    cancelRequested: v.optional(v.boolean()),
    /** Step counter; a scheduled step only runs when its number matches. */
    tick: v.number(),
    leaseUntil: v.optional(v.number()),
    restarts: v.number(),
    reservation: v.optional(reservationValidator),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_requestKey", ["requestKey"]),

  aiAssets: defineTable({
    assetId: v.id("assets"),
    refId: v.string(),
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    designId: v.optional(v.id("designs")),
    runId: v.optional(v.id("aiRuns")),
    task: v.string(),
    provider: v.string(),
    model: v.string(),
    /** Prompt preview (truncated). */
    prompt: v.string(),
    seed: v.optional(v.number()),
    sourceAssetIds: v.optional(v.array(v.id("assets"))),
    billing: aiBillingValidator,
    costCredits: v.number(),
    createdAt: v.number(),
  })
    .index("by_asset", ["assetId"])
    .index("by_run", ["runId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  aiModelCatalog: defineTable({
    source: v.union(v.literal("openrouter"), v.literal("fal")),
    /** CatalogModel[] JSON in file storage (the fal catalog is too large for a document). */
    storageId: v.id("_storage"),
    count: v.number(),
    fetchedAt: v.number(),
    /** Last fetch attempt (a failed one keeps the old catalog); attempts are spaced by MIN_REFRESH_MS. */
    checkedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_source", ["source"]),
};
