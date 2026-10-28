import { z } from "zod";

// Shared building blocks of the Agent API v1 contract. Every request/response schema in this folder is the
// single source of truth for the Convex HTTP handlers (validation), the OpenAPI document and the SDK types.

export const API_VERSION = "v1";
export const API_BASE_PATH = "/api/v1";

/** Scopes an API key can carry (mirrors convex/lib/validators.ts `ALL_API_KEY_SCOPES`). */
export const API_SCOPES = [
  "designs:read",
  "designs:write",
  "assets:read",
  "assets:write",
  "templates:read",
  "brand:read",
  "brand:write",
  "ai:run",
  "exports:write",
  "mcp",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const ApiScopeSchema = z.enum(API_SCOPES);

export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "designs:read":
    "List and read designs, documents and transactions; describe and preview pages; list folders.",
  "designs:write":
    "Create, rename, archive and delete designs; commit transactions; instantiate templates; apply brand kits.",
  "assets:read": "List assets and get signed URLs.",
  "assets:write": "Upload, rename and delete assets.",
  "templates:read": "Search and read templates.",
  "brand:read": "Read brand kits.",
  "brand:write": "Create, change and delete brand kits.",
  "ai:run":
    "Start and control agent runs, asset generation and workflows, and list models. Spends credits on the hosted plan.",
  "exports:write": "Request exports and read their status.",
  mcp: "Connect to the MCP server (requires the MCP feature: Pro or self-hosted).",
};

/**
 * Stable error codes. The first group mirrors convex/lib/errors.ts; the rest are produced by the HTTP layer.
 */
export const API_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "CONFLICT",
  "EXPIRED",
  "LIMIT_REACHED",
  "FEATURE_UNAVAILABLE",
  "RATE_LIMITED",
  "BILLING_DISABLED",
  "NOT_CONFIGURED",
  "EMAIL_NOT_VERIFIED",
  "INTERNAL",
  "INSUFFICIENT_SCOPE",
  "METHOD_NOT_ALLOWED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "UPSTREAM_UNAVAILABLE",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** HTTP status for each error code (the same mapping is documented in the OpenAPI description). */
export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INSUFFICIENT_SCOPE: 403,
  FEATURE_UNAVAILABLE: 403,
  EMAIL_NOT_VERIFIED: 403,
  BILLING_DISABLED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INVALID_ARGUMENT: 400,
  CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  EXPIRED: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  LIMIT_REACHED: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_CONFIGURED: 501,
  UPSTREAM_UNAVAILABLE: 503,
};

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum(API_ERROR_CODES),
        message: z.string().describe("Human-readable, safe to show to users."),
        requestId: z.string().optional().describe("Correlates the request with server logs."),
        field: z.string().optional(),
        retryAfterMs: z.number().optional(),
        scope: z.string().optional(),
        feature: z.string().optional(),
        limit: z.string().optional(),
        max: z.number().optional(),
        current: z.number().optional(),
        required: z.array(z.string()).optional().describe("Scopes the request needs."),
        issues: z
          .array(
            z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }),
          )
          .optional()
          .describe("Validation issues for INVALID_ARGUMENT."),
      })
      .catchall(z.unknown()),
  })
  .meta({ id: "Error" });
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

/** Convex document ids are opaque strings (letters and digits). */
export const DocIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+$/, "invalid id");

export const LimitSchema = (max: number) => z.coerce.number().int().min(1).max(max);
export const CursorSchema = z.string().min(1).max(2_000);

export const BooleanQuerySchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1"),
]);

/** `{ items, nextCursor }` pages: pass `nextCursor` back as `cursor`; null on the last page. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const DeletedSchema = z.object({ deleted: z.literal(true) });

export const ColorHexSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/, 'expected "#rrggbb" or "#rrggbbaa" (lowercase)');

export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

export type Schema = z.ZodType;
export type SchemaOutput<T extends z.ZodType> = z.output<T>;

/** Validate a value against a contract schema (lets consumers validate without importing zod). */
export function validate<T extends z.ZodType>(
  schema: T,
  value: unknown,
): { success: true; data: z.output<T> } | { success: false; issues: ValidationIssue[] } {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.slice(0, 50).map((i) => ({
      path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
      message: i.message,
    })),
  };
}
