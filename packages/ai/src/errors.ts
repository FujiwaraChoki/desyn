// Typed errors with stable codes so Convex actions, the web app and the Agent API can map them to UI messages
// and HTTP statuses without parsing strings.

export type AiErrorCode =
  | "provider-not-configured"
  | "provider-error"
  | "unsupported"
  | "moderation-blocked"
  | "budget-exceeded"
  | "invalid-output"
  | "invalid-input"
  | "not-found"
  | "cancelled";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: AiErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiError";
    this.code = code;
    this.details = details;
  }
}

export function isAiError(error: unknown, code?: AiErrorCode): error is AiError {
  return error instanceof AiError && (code === undefined || error.code === code);
}

/** A message that is safe to show to users and models (never includes request bodies or keys). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
