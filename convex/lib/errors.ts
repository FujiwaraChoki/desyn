import { ConvexError } from "convex/values";

/**
 * Stable error codes surfaced to clients as `ConvexError<{ code, message, ... }>`.
 * Clients switch on `error.data.code`; `message` is human-readable and safe to show.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "EXPIRED"
  | "LIMIT_REACHED"
  | "FEATURE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "BILLING_DISABLED"
  | "NOT_CONFIGURED"
  | "EMAIL_NOT_VERIFIED"
  | "INTERNAL";

export type ErrorData = {
  code: ErrorCode;
  message: string;
  [key: string]: string | number | boolean | null | undefined | string[];
};

export class DesynError extends ConvexError<ErrorData> {}

export function appError(
  code: ErrorCode,
  message: string,
  extra?: Omit<ErrorData, "code" | "message">,
): DesynError {
  return new DesynError({ code, message, ...extra });
}

export const errors = {
  unauthenticated: () => appError("UNAUTHENTICATED", "Sign in to continue."),
  forbidden: (message = "You do not have access to this.") => appError("FORBIDDEN", message),
  notFound: (what = "Item") => appError("NOT_FOUND", `${what} not found.`),
  invalid: (message: string, field?: string) =>
    appError("INVALID_ARGUMENT", message, field ? { field } : undefined),
  conflict: (message: string) => appError("CONFLICT", message),
  expired: (message: string) => appError("EXPIRED", message),
  limit: (limit: string, max: number, current: number) =>
    appError("LIMIT_REACHED", `You reached your plan limit for ${limit} (${max}).`, {
      limit,
      max,
      current,
    }),
  feature: (feature: string) =>
    appError("FEATURE_UNAVAILABLE", "This feature is not included in your plan.", { feature }),
  rateLimited: (retryAfterMs: number, scope: string) =>
    appError("RATE_LIMITED", "Too many requests. Try again shortly.", {
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
      scope,
    }),
  billingDisabled: () =>
    appError("BILLING_DISABLED", "Billing is not available in this edition of Desyn."),
  notConfigured: (what: string) => appError("NOT_CONFIGURED", `${what} is not configured.`),
};

/** True when `err` is an application error with the given code (works across ConvexError boundaries). */
export function isAppError(err: unknown, code?: ErrorCode): err is ConvexError<ErrorData> {
  if (!(err instanceof ConvexError)) return false;
  const data = err.data as Partial<ErrorData> | undefined;
  if (!data || typeof data !== "object" || typeof data.code !== "string") return false;
  return code === undefined || data.code === code;
}
