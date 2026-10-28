import {
  AssetRefSchema,
  DescriptionSchema,
  DesignKindSchema,
  DesignSchema,
  OpSchema,
  TransactionSchema,
  TransactionSourceSchema,
  UnitSchema,
} from "@desyn/schema";
import { z } from "zod";
import {
  ApiScopeSchema,
  BooleanQuerySchema,
  ColorHexSchema,
  CursorSchema,
  DocIdSchema,
  LimitSchema,
  pageOf,
} from "./common";

// Request and response schemas of every v1 resource. Document-model types (Design, Op, Transaction,
// Description, AssetRef) come from @desyn/schema so the API speaks DOCUMENT_MODEL.md exactly.

// --- account ------------------------------------------------------------------------------------------------

export const PlanIdSchema = z.enum(["free", "pro", "selfhost"]);
export const RoleSchema = z.enum(["owner", "admin", "editor", "commenter", "viewer"]);

export const MeSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    plan: PlanIdSchema,
    planName: z.string(),
    edition: z.enum(["hosted", "selfhost"]),
    workspaceId: z
      .string()
      .describe("The workspace the API key belongs to; every call is scoped to it."),
    workspaceName: z.string(),
    role: RoleSchema.describe("The key owner's role in that workspace."),
    keyId: z.string(),
    scopes: z
      .array(ApiScopeSchema)
      .describe("Effective scopes (write scopes need the editor role)."),
  })
  .meta({ id: "Me" });

export const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["personal", "team"]),
    role: RoleSchema,
    current: z.boolean().describe("True for the workspace the key belongs to."),
  })
  .meta({ id: "Workspace" });
export const WorkspaceListSchema = z.object({ items: z.array(WorkspaceSchema) });

export const CreditsSchema = z
  .object({
    period: z.string().describe('Billing period, e.g. "2026-10".'),
    plan: PlanIdSchema,
    granted: z.number().nullable().describe("Monthly grant; null = unlimited (self-hosted)."),
    used: z.number(),
    reserved: z.number().describe("Held by running jobs."),
    overage: z.number().describe("Usage past the pool. Never billed."),
    remaining: z.number().nullable(),
    throttled: z.boolean().describe("True while AI requests are soft-throttled."),
  })
  .catchall(z.unknown())
  .meta({ id: "Credits" });

const MeterSchema = z.object({
  used: z.number(),
  limit: z.number().nullable(),
  ratio: z.number().nullable(),
});
export const UsageSchema = z
  .object({
    period: z.string(),
    plan: PlanIdSchema,
    planName: z.string(),
    meters: z.object({
      designs: MeterSchema,
      storageBytes: MeterSchema,
      exports: MeterSchema,
      brandKits: MeterSchema,
      workspaces: MeterSchema,
      aiRequests: MeterSchema,
      uploads: MeterSchema,
    }),
    limits: z.record(z.string(), z.number().nullable()),
    credits: CreditsSchema,
    fairUse: z
      .object({
        perMinuteAiRequests: z.number(),
        perDayAiRequests: z.number(),
        maxConcurrentRuns: z.number(),
        byokBypassesCredits: z.boolean(),
        noOverageCharges: z.boolean(),
      })
      .nullable(),
    api: z
      .object({
        requestsPerMinute: z.number().describe("Sustained request rate of this API key."),
        burst: z.number().describe("Requests that can be made at once."),
      })
      .describe("Agent API fair-use limits of the key."),
  })
  .meta({ id: "Usage" });

// --- designs --------------------------------------------------------------------------------------------------

export const DesignStateSchema = z.enum(["active", "archived", "trashed"]);
export const PermissionSchema = z.enum(["view", "comment", "edit", "manage"]);

export const DesignSummarySchema = z
  .object({
    id: z.string().describe("Design id (Convex document id) used in API paths."),
    key: z.string().describe("The 12-character `Design.id` inside the document."),
    name: z.string(),
    kind: z.string(),
    workspaceId: z.string(),
    folderId: z.string().nullable(),
    ownerId: z.string(),
    state: DesignStateSchema,
    pageCount: z.number().int(),
    width: z.number().describe("First page width in design px."),
    height: z.number().describe("First page height in design px."),
    thumbnailUrl: z.string().nullable(),
    templateId: z.string().nullable(),
    permission: PermissionSchema.nullable(),
    seq: z.number().int().describe("Latest accepted transaction seq."),
    createdAt: z.number(),
    updatedAt: z.number(),
    archivedAt: z.number().nullable(),
    deletedAt: z.number().nullable(),
  })
  .meta({ id: "DesignSummary" });

export const DesignListQuerySchema = z.object({
  state: DesignStateSchema.optional().describe("Default `active`."),
  kind: DesignKindSchema.optional(),
  folderId: z
    .string()
    .optional()
    .describe('Only designs in this folder; "root" for designs outside folders.'),
  mine: BooleanQuerySchema.optional().describe("Only designs the key's member created."),
  search: z.string().max(200).optional().describe("Full-text search on the name."),
  limit: LimitSchema(100).optional().describe("1-100, default 25."),
  cursor: CursorSchema.optional(),
});
export const DesignListSchema = pageOf(DesignSummarySchema).meta({ id: "DesignList" });

export const CreateDesignBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    kind: DesignKindSchema.optional().describe('Default "custom" (or the template\'s kind).'),
    presetId: z
      .string()
      .max(100)
      .optional()
      .describe("Page preset id (e.g. `instagram-post`); see @desyn/schema PAGE_PRESETS."),
    width: z
      .number()
      .min(1)
      .max(100_000)
      .optional()
      .describe("Custom first page width (design px)."),
    height: z.number().min(1).max(100_000).optional(),
    unit: UnitSchema.optional(),
    folderId: DocIdSchema.optional(),
    templateId: DocIdSchema.optional().describe("Start from this template (id)."),
  })
  .refine((b) => (b.width === undefined) === (b.height === undefined), {
    message: "width and height go together",
    path: ["width"],
  })
  .meta({ id: "CreateDesignBody" });
export type CreateDesignBody = z.infer<typeof CreateDesignBodySchema>;

export const CreatedDesignSchema = DesignSummarySchema.extend({
  firstPageId: z
    .string()
    .nullable()
    .describe("Id of the first page node, handy as a create parent."),
}).meta({ id: "CreatedDesign" });

export const UpdateDesignBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    folderId: DocIdSchema.nullable().optional().describe("null moves the design to the root."),
  })
  .meta({ id: "UpdateDesignBody" });

export const DeleteDesignQuerySchema = z.object({
  permanent: BooleanQuerySchema.optional().describe(
    "Permanently delete a design that is already in the trash. Default: move to the trash.",
  ),
});
export const DeletedDesignSchema = z
  .object({ deleted: z.literal(true), state: z.enum(["trashed", "purged"]) })
  .meta({ id: "DeletedDesign" });

export const DocumentQuerySchema = z.object({
  pageId: z.string().max(64).optional().describe("Only this page's subtree (plus root)."),
});
export const DocumentSchema = z
  .object({
    seq: z.number().int().describe("The seq the document reflects."),
    consistent: z
      .boolean()
      .describe("False when chunks were read at different seqs (reload for a strict snapshot)."),
    design: DesignSchema,
  })
  .meta({ id: "Document" });

/** A transaction as clients send it: the server fills id (from Idempotency-Key), label, source and ts. */
export const TxInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]{12}$/)
      .optional()
      .describe(
        "Idempotency key of the commit; derived from the Idempotency-Key header or generated.",
      ),
    label: z.string().max(200).optional().describe('History label. Default "API edit".'),
    ops: z.array(OpSchema).min(1).max(2_000),
    source: TransactionSourceSchema.optional().describe('Default "ai".'),
    actor: z
      .object({ agent: z.string().max(100).optional(), runId: z.string().max(100).optional() })
      .optional()
      .describe("`userId` is always set to the key's member."),
    ts: z.number().optional(),
  })
  .meta({ id: "TransactionInput" });
export type TxInput = z.infer<typeof TxInputSchema>;

export const CommitBodySchema = z
  .object({
    baseSeq: z.number().int().min(0).optional().describe("The seq your view is based on."),
    tx: TxInputSchema,
  })
  .meta({ id: "CommitBody" });
export type CommitBody = z.infer<typeof CommitBodySchema>;

export const DroppedOpSchema = z.object({ index: z.number().int(), reason: z.string() });
export const CommitResultSchema = z
  .object({
    seq: z.number().int(),
    txId: z.string(),
    applied: z.array(OpSchema).describe("The ops that took effect (normalized)."),
    dropped: z.array(DroppedOpSchema),
    duplicate: z.boolean().describe("True when this transaction id had been committed before."),
  })
  .meta({ id: "CommitResult" });

export const TransactionsQuerySchema = z.object({
  since: z.coerce.number().int().min(0).describe("Return transactions with seq > since."),
  limit: LimitSchema(200).optional().describe("1-200, default 100."),
});
export const TransactionEntrySchema = z.object({
  seq: z.number().int(),
  txId: z.string(),
  tx: TransactionSchema,
  actor: z.string().nullable().describe("User id of the author."),
  source: z.string(),
  ts: z.number(),
});
export const TransactionListSchema = z
  .object({
    items: z.array(TransactionEntrySchema),
    hasMore: z.boolean(),
    reload: z
      .boolean()
      .describe("True when older entries were compacted: load the document again."),
    latestSeq: z.number().int(),
  })
  .meta({ id: "TransactionList" });

export const DescribeQuerySchema = z.object({
  pageId: z.string().max(64).optional().describe("Default: the first page."),
  selection: z.string().max(10_000).optional().describe("Comma-separated node ids."),
  maxDepth: z.coerce.number().int().min(1).max(64).optional(),
});
export { DescriptionSchema };

export const RegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export const PreviewBodySchema = z
  .object({
    pageId: z.string().max(64).optional().describe("Default: the first page."),
    region: RegionSchema.optional().describe("Crop in page coordinates."),
    scale: z.number().min(0.05).max(4).optional().describe("0.05-4, default 1."),
    maxSize: z
      .number()
      .int()
      .min(64)
      .max(4096)
      .optional()
      .describe("Cap the longer edge in pixels (applied after scale). Default 2048."),
    format: z.enum(["png", "webp", "jpeg"]).optional().describe("Default png."),
    background: z.union([ColorHexSchema, z.literal("transparent")]).optional(),
  })
  .meta({ id: "PreviewBody" });
export type PreviewBody = z.infer<typeof PreviewBodySchema>;

export const ApplyBrandBodySchema = z
  .object({
    brandKitId: DocIdSchema.optional().describe("Default: the workspace's default brand kit."),
    pageIds: z.array(z.string()).max(500).optional().describe("Default: every page."),
    ids: z.array(z.string()).max(5_000).optional().describe("Only these nodes (and descendants)."),
    colors: z.boolean().optional().describe("Map colors onto the palette. Default true."),
    fonts: z.boolean().optional().describe("Map fonts onto the kit fonts. Default true."),
    logo: z.enum(["replace", "add", "none"]).optional().describe('Default "replace".'),
  })
  .meta({ id: "ApplyBrandBody" });
export const ApplyBrandResultSchema = z
  .object({
    commit: CommitResultSchema.nullable().describe("null when nothing had to change."),
    brandKitId: z.string(),
    recolored: z.number().int(),
    fontsChanged: z.number().int(),
    logos: z.array(z.string()),
    contrastFixes: z.array(z.string()),
    colorMap: z.record(z.string(), z.string()),
  })
  .meta({ id: "ApplyBrandResult" });

// --- exports --------------------------------------------------------------------------------------------------

export const ExportFormatSchema = z.enum([
  "png",
  "jpeg",
  "webp",
  "svg",
  "pdf",
  "pptx",
  "gif",
  "mp4",
]);
export const ExportBodySchema = z
  .object({
    format: ExportFormatSchema,
    pages: z
      .union([z.literal("all"), z.array(z.string()).min(1).max(500)])
      .optional()
      .describe('"all" (default) or page ids in output order.'),
    scale: z.number().min(0.1).max(8).optional(),
    quality: z.number().min(1).max(100).optional(),
    background: z.union([ColorHexSchema, z.literal("transparent")]).optional(),
    pdf: z.object({ bleed: z.boolean(), cropMarks: z.boolean(), cmyk: z.boolean() }).optional(),
    notify: z
      .boolean()
      .optional()
      .describe("Email the member when ready (default: large jobs only)."),
  })
  .meta({ id: "ExportBody" });
export type ExportBody = z.infer<typeof ExportBodySchema>;

export const ExportSchema = z
  .object({
    id: z.string(),
    designId: z.string(),
    format: ExportFormatSchema,
    pages: z.union([z.literal("all"), z.array(z.string())]),
    scale: z.number(),
    status: z.enum(["queued", "rendering", "ready", "failed", "expired"]),
    files: z.array(
      z.object({
        pageId: z.string().nullable(),
        fileName: z.string(),
        contentType: z.string(),
        bytes: z.number(),
        url: z.string().nullable().describe("Signed download URL (valid for 24 h)."),
      }),
    ),
    error: z.string().nullable(),
    attempts: z.number().int(),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
    expiresAt: z.number().nullable(),
  })
  .meta({ id: "Export" });
export type ApiExport = z.infer<typeof ExportSchema>;

// --- assets -----------------------------------------------------------------------------------------------------

export const AssetKindSchema = z.enum(["image", "svg", "font", "video", "audio", "lottie", "data"]);
export const AssetSourceSchema = z.enum(["upload", "ai", "stock", "template", "brand"]);

export const AssetSchema = z
  .object({
    id: z.string().describe("Asset id used in API paths."),
    refId: z.string().describe("The `AssetRef.id` to use inside designs."),
    kind: AssetKindSchema,
    name: z.string(),
    mime: z.string(),
    bytes: z.number(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    durationMs: z.number().nullable(),
    hash: z.string().nullable(),
    status: z.enum(["pending", "ready", "failed", "deleted"]),
    source: AssetSourceSchema,
    url: z.string().nullable().describe("Signed GET URL (never persist it in a design)."),
    urlExpiresAt: z.number().nullable(),
    assetRef: AssetRefSchema.describe(
      'Ready-made AssetRef: add it with an `{ "op": "asset", "set": { [refId]: assetRef } }` op.',
    ),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: "Asset" });
export type ApiAsset = z.infer<typeof AssetSchema>;

export const AssetListQuerySchema = z.object({
  kind: AssetKindSchema.optional(),
  search: z.string().max(200).optional(),
  limit: LimitSchema(100).optional().describe("1-100, default 50."),
  cursor: CursorSchema.optional(),
});
export const AssetListSchema = pageOf(AssetSchema).meta({ id: "AssetList" });

export const UploadRequestBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z
      .string()
      .min(3)
      .max(200)
      .describe("e.g. image/png, image/svg+xml, font/woff2, video/mp4."),
    bytes: z.number().int().positive().describe("Exact size in bytes."),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional()
      .describe("Hex digest; identical files in the workspace are reused (no upload needed)."),
    declaredKind: z.enum(["lottie", "data"]).optional().describe("For application/json uploads."),
    source: z.enum(["upload", "brand"]).optional(),
    family: z.string().max(100).optional().describe("Font family (fonts only)."),
    weight: z.number().int().min(1).max(1000).optional(),
    style: z.enum(["normal", "italic"]).optional(),
  })
  .meta({ id: "UploadRequestBody" });
export type UploadRequestBody = z.infer<typeof UploadRequestBodySchema>;

export const UploadTicketSchema = z
  .object({
    assetId: z.string(),
    refId: z.string(),
    deduplicated: z
      .boolean()
      .describe("True when an identical ready file was reused: skip the upload."),
    upload: z
      .object({
        url: z.string(),
        method: z.literal("PUT"),
        headers: z.record(z.string(), z.string()).describe("Send exactly these headers."),
        expiresAt: z.number(),
      })
      .nullable(),
  })
  .meta({ id: "UploadTicket" });

export const FinalizeBodySchema = z
  .object({
    media: z
      .object({
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        durationMs: z.number().positive().optional(),
      })
      .optional()
      .describe("Probed metadata for video/audio the server cannot measure."),
  })
  .meta({ id: "FinalizeBody" });

export const RenameBodySchema = z.object({ name: z.string().min(1).max(200) });

// --- templates --------------------------------------------------------------------------------------------------

export const TemplateSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    kind: z.string(),
    category: z.string(),
    categories: z.array(z.string()),
    tags: z.array(z.string()),
    premium: z.boolean(),
    pageCount: z.number().int(),
    width: z.number(),
    height: z.number(),
    popularity: z.number(),
    thumbnails: z.array(
      z.object({ url: z.string().nullable(), width: z.number(), height: z.number() }),
    ),
    updatedAt: z.number(),
  })
  .meta({ id: "Template" });
export const TemplateDetailSchema = TemplateSchema.extend({
  canUse: z
    .boolean()
    .describe("False for premium templates when the plan lacks templates.premium."),
  slots: z
    .array(
      z.object({
        slot: z.string(),
        type: z.enum(["text", "image"]),
        nodeId: z.string(),
        text: z.string().nullable(),
      }),
    )
    .describe("Named layers meant to be replaced (`meta.slot`)."),
}).meta({ id: "TemplateDetail" });

export const TemplateSearchQuerySchema = z.object({
  q: z.string().max(200).optional().describe("Free text, e.g. `minimal bakery menu`."),
  kind: z.string().max(40).optional(),
  category: z.string().max(60).optional(),
  premium: BooleanQuerySchema.optional(),
  sort: z.enum(["popular", "new"]).optional().describe("Without `q`. Default popular."),
  limit: LimitSchema(60).optional().describe("1-60, default 24."),
  cursor: CursorSchema.optional(),
});
export const TemplateListSchema = pageOf(TemplateSchema).meta({ id: "TemplateList" });

export const InstantiateBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    folderId: DocIdSchema.optional(),
    slots: z
      .record(z.string(), z.string().max(10_000))
      .optional()
      .describe("Slot name -> text for text slots, or an asset id / refId for image slots."),
    brandKitId: DocIdSchema.optional().describe("Apply this brand kit after instantiating."),
  })
  .meta({ id: "InstantiateBody" });
export type InstantiateBody = z.infer<typeof InstantiateBodySchema>;

export const InstantiatedSchema = CreatedDesignSchema.extend({
  filledSlots: z.array(z.string()),
  unknownSlots: z.array(z.string()),
  brandApplied: z.boolean(),
}).meta({ id: "InstantiatedDesign" });

// --- brand kits ---------------------------------------------------------------------------------------------------

export const BrandColorRoleSchema = z.enum([
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
  "text",
  "muted",
  "success",
  "warning",
  "danger",
  "other",
]);
export const BrandFontSchema = z.object({
  family: z.string().min(1).max(100),
  weight: z.number().min(1).max(1000),
  style: z.enum(["normal", "italic"]),
  assetId: DocIdSchema.optional().describe("Custom font upload (asset of kind font)."),
  fallback: z.string().max(200).optional(),
});
export const BrandVoiceSchema = z.object({
  tone: z.string().max(200),
  description: z.string().max(4_000),
  keywords: z.array(z.string().max(80)).max(30),
  avoid: z.array(z.string().max(80)).max(30),
  sampleCopy: z.string().max(4_000).optional(),
});
export const LogoVariantSchema = z.enum([
  "primary",
  "secondary",
  "icon",
  "wordmark",
  "light",
  "dark",
  "other",
]);

export const BrandKitSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    isDefault: z.boolean(),
    colors: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        value: z.string(),
        role: BrandColorRoleSchema.optional(),
      }),
    ),
    logos: z.array(
      z.object({
        id: z.string(),
        assetId: z.string(),
        name: z.string(),
        variant: LogoVariantSchema,
        refId: z.string().nullable(),
        mime: z.string().nullable(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        url: z.string().nullable(),
      }),
    ),
    fonts: z.object({
      heading: BrandFontSchema.extend({
        url: z.string().nullable(),
        refId: z.string().nullable(),
      }).optional(),
      body: BrandFontSchema.extend({
        url: z.string().nullable(),
        refId: z.string().nullable(),
      }).optional(),
      accent: BrandFontSchema.extend({
        url: z.string().nullable(),
        refId: z.string().nullable(),
      }).optional(),
    }),
    voice: BrandVoiceSchema.nullable(),
    rules: z.array(z.string()),
    guidelines: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: "BrandKit" });
export const BrandKitListSchema = z
  .object({ items: z.array(BrandKitSchema) })
  .meta({ id: "BrandKitList" });

const brandKitFields = {
  colors: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1).max(60),
        value: ColorHexSchema,
        role: BrandColorRoleSchema.optional(),
      }),
    )
    .max(64)
    .optional(),
  logos: z
    .array(
      z.object({
        id: z.string().optional(),
        assetId: DocIdSchema,
        name: z.string().min(1).max(60),
        variant: LogoVariantSchema,
      }),
    )
    .max(20)
    .optional(),
  fonts: z
    .object({
      heading: BrandFontSchema.optional(),
      body: BrandFontSchema.optional(),
      accent: BrandFontSchema.optional(),
    })
    .optional(),
  voice: BrandVoiceSchema.nullable().optional(),
  rules: z.array(z.string().min(1).max(500)).max(50).optional(),
  guidelines: z.string().max(20_000).nullable().optional(),
};
export const CreateBrandKitBodySchema = z
  .object({ name: z.string().min(1).max(100), ...brandKitFields })
  .meta({ id: "CreateBrandKitBody" });
export const UpdateBrandKitBodySchema = z
  .object({ name: z.string().min(1).max(100).optional(), ...brandKitFields })
  .meta({ id: "UpdateBrandKitBody" });

// --- folders ------------------------------------------------------------------------------------------------------

export const FolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
    color: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: "Folder" });
export const FolderListSchema = z
  .object({ items: z.array(FolderSchema) })
  .meta({ id: "FolderList" });

// --- AI runs, asset generation, workflows, models ------------------------------------------------------------

export const RUN_STATUSES = [
  "queued",
  "running",
  "needs-input",
  "completed",
  "cancelled",
  "budget-exceeded",
  "step-limit",
  "failed",
] as const;
/** Statuses after which a run produces no more events. */
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "cancelled",
  "budget-exceeded",
  "step-limit",
  "failed",
] as const;

export const AiRunSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["agent", "asset", "workflow"]),
    designId: z.string().nullable(),
    status: z.string().describe(`One of ${RUN_STATUSES.join(", ")}.`),
    mode: z.string().nullable(),
    goal: z.string().nullable(),
    question: z
      .object({ question: z.string(), options: z.array(z.string()) })
      .nullable()
      .describe("Set while the run waits for an answer (status needs-input)."),
    result: z
      .object({
        summary: z.string().optional(),
        changes: z.array(z.string()).optional(),
        followUps: z.array(z.string()).optional(),
        assetId: z.string().optional().describe("Generated asset (asset runs)."),
        refId: z.string().optional(),
        transactions: z.number().optional(),
      })
      .catchall(z.unknown())
      .nullable(),
    error: z.string().nullable(),
    costCredits: z.number(),
    steps: z.number().int().describe("Agent steps taken so far."),
    createdAt: z.number(),
    updatedAt: z.number(),
    finishedAt: z.number().nullable(),
  })
  .catchall(z.unknown())
  .meta({ id: "AiRun" });

export const AiRunEventSchema = z
  .object({
    index: z.number().int().describe("Position in the run's event log (0-based)."),
    type: z
      .string()
      .describe(
        "start, step, thinking, text, tool-call, tool-result, applied-tx, preview, plan, progress, credits, question, error, done.",
      ),
    ts: z.number(),
  })
  .catchall(z.unknown())
  .meta({ id: "AiRunEvent" });

export const AiRunEventListSchema = z
  .object({
    items: z.array(AiRunEventSchema),
    next: z.number().int().describe("Pass as `after` to continue."),
    done: z.boolean().describe("The run finished and every event was returned."),
  })
  .meta({ id: "AiRunEventList" });

export const StartRunBodySchema = z
  .object({
    goal: z.string().min(1).max(8_000).describe("What you want, in plain language."),
    mode: z
      .enum(["edit", "generate", "critique"])
      .optional()
      .describe(
        "`edit` (default) changes the design, `generate` builds pages, `critique` only reviews.",
      ),
    pageId: z.string().max(64).optional(),
    selection: z
      .array(z.string())
      .max(500)
      .optional()
      .describe('Node ids "this" / "these" refer to.'),
    model: z.string().max(200).optional().describe('Override the routed model ("provider:model").'),
    maxSteps: z.number().int().min(1).max(100).optional(),
    maxCredits: z
      .number()
      .min(0)
      .optional()
      .describe("Stop before spending more credits than this."),
  })
  .meta({ id: "StartRunBody" });

export const RunEventsQuerySchema = z.object({
  after: z.coerce
    .number()
    .int()
    .min(-1)
    .optional()
    .describe("Events with index > after. Default -1 (all)."),
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Long-poll: wait up to this many seconds for new events. Default 0."),
  limit: LimitSchema(500).optional().describe("1-500, default 200."),
});

export const AnswerBodySchema = z
  .object({ answer: z.string().min(1).max(4_000) })
  .meta({ id: "AnswerBody" });

export const GenerateAssetBodySchema = z
  .object({
    task: z.enum([
      "image",
      "svg",
      "remove-background",
      "inpaint",
      "outpaint",
      "upscale",
      "mockup",
      "trace",
    ]),
    prompt: z
      .string()
      .max(4_000)
      .optional()
      .describe("Required for image, svg, inpaint and mockup."),
    assetId: z.string().optional().describe("Source asset for transforms."),
    maskAssetId: z.string().optional().describe("Mask for inpaint (white = replace)."),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
    scale: z
      .union([z.literal(2), z.literal(4)])
      .optional()
      .describe("Upscale factor."),
    style: z.string().max(200).optional(),
    designId: z.string().optional().describe("Use this design's brand kit and attach the result."),
  })
  .meta({ id: "GenerateAssetBody" });

export const WorkflowTypeSchema = z.enum([
  "campaign",
  "variants",
  "resize",
  "localize",
  "bulk",
  "exportBundle",
]);
export const StartWorkflowBodySchema = z
  .object({
    type: WorkflowTypeSchema,
    designId: z.string().optional().describe("Source design (every workflow except campaign)."),
    input: z
      .record(z.string(), z.unknown())
      .describe("Workflow-specific input (see the AI workflows docs)."),
  })
  .meta({ id: "StartWorkflowBody" });

export const WorkflowSchema = z
  .object({
    id: z.string(),
    type: WorkflowTypeSchema,
    status: z.string().describe("queued, running, completed, failed or cancelled."),
    designId: z.string().nullable(),
    progress: z.object({ done: z.number().int(), total: z.number().int() }),
    outputs: z.array(
      z
        .object({ designId: z.string().optional(), label: z.string().optional() })
        .catchall(z.unknown()),
    ),
    error: z.string().nullable(),
    costCredits: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    finishedAt: z.number().nullable(),
  })
  .catchall(z.unknown())
  .meta({ id: "Workflow" });

export const ModelsQuerySchema = z.object({ task: z.string().max(60).optional() });
export const ModelListSchema = z
  .object({
    tasks: z.record(
      z.string(),
      z.array(
        z
          .object({
            id: z.string().describe('"provider:model".'),
            label: z.string(),
            source: z.string().describe("server, byok or local."),
            default: z.boolean(),
          })
          .catchall(z.unknown()),
      ),
    ),
  })
  .meta({ id: "ModelList" });
