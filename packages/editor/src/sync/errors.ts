// Classification of transport errors for the sync client. Convex functions throw
// `ConvexError<{ code, message, ... }>` (convex/lib/errors.ts); everything else (dropped sockets, server
// restarts, "Server Error") is treated as transient.

export type ErrorKind =
  /** Transient: retry the same transaction (commits are idempotent on `tx.id`). */
  | "retry"
  /** The session expired: keep the queue and retry slowly while the auth client refreshes. */
  | "auth"
  /** The client state is ahead of / inconsistent with the server: reload the design, keep pending work. */
  | "reload"
  /** The server will never accept this transaction: roll it back and tell the user. */
  | "fatal";

export interface ClassifiedError {
  kind: ErrorKind;
  code: string;
  message: string;
  /** Server-suggested delay (RATE_LIMITED). */
  retryAfterMs?: number;
}

interface ErrorData {
  code?: unknown;
  message?: unknown;
  field?: unknown;
  retryAfterMs?: unknown;
}

/** The `data` of a ConvexError-shaped value, if any (duck-typed so fakes and other clients work too). */
export function errorData(error: unknown): ErrorData | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { data: unknown }).data;
  return typeof data === "object" && data !== null ? (data as ErrorData) : null;
}

export function errorMessage(error: unknown): string {
  const data = errorData(error);
  if (data && typeof data.message === "string") return data.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyError(error: unknown): ClassifiedError {
  const data = errorData(error);
  const message = errorMessage(error);
  // Argument validators reject before any function code runs (e.g. a malformed design id in the URL). Such a
  // request fails the same way every time, so it is never retried.
  if (!data && /ArgumentValidationError/.test(message)) {
    return /Path: \.designId\b/.test(message)
      ? { kind: "fatal", code: "NOT_FOUND", message: "Design not found." }
      : { kind: "fatal", code: "INVALID_ARGUMENT", message: "The request was not valid." };
  }
  const code = data && typeof data.code === "string" ? data.code : "NETWORK";
  switch (code) {
    case "RATE_LIMITED":
      return {
        kind: "retry",
        code,
        message,
        ...(typeof data?.retryAfterMs === "number" ? { retryAfterMs: data.retryAfterMs } : {}),
      };
    case "INTERNAL":
    case "NETWORK":
      return { kind: "retry", code, message };
    case "UNAUTHENTICATED":
      return { kind: "auth", code, message };
    case "INVALID_ARGUMENT":
      // `baseSeq is ahead of the server`: our view of the log is wrong (restored backup, compaction race).
      return { kind: data?.field === "baseSeq" ? "reload" : "fatal", code, message };
    default:
      return { kind: "fatal", code, message };
  }
}
