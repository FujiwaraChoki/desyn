import { ConvexError } from "convex/values";

/** Structured error data thrown by Desyn's Convex functions (convex/lib/errors.ts). */
export interface AppErrorData {
  code: string;
  message: string;
  [key: string]: unknown;
}

function isAppErrorData(value: unknown): value is AppErrorData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppErrorData).code === "string" &&
    typeof (value as AppErrorData).message === "string"
  );
}

/** The structured data of a Convex app error, if `error` is one. */
export function appError(error: unknown): AppErrorData | null {
  if (error instanceof ConvexError && isAppErrorData(error.data)) return error.data;
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (isAppErrorData(data)) return data;
  }
  return null;
}

export function isAppError(error: unknown, code?: string): boolean {
  const data = appError(error);
  return data !== null && (code === undefined || data.code === code);
}

/** Messages for Better Auth error codes, written in the product voice. */
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD:
    "That email and password don't match. Try again or reset your password.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account with this email already exists. Sign in instead.",
  EMAIL_NOT_VERIFIED: "Verify your email first. We just sent you a new link.",
  PASSWORD_TOO_SHORT: "Use at least 8 characters for your password.",
  PASSWORD_TOO_LONG: "Use at most 128 characters for your password.",
  INVALID_TOKEN: "This link has expired or was already used. Request a new one.",
  TOKEN_EXPIRED: "This link has expired. Request a new one.",
  INVALID_PASSWORD: "That password is not correct.",
  SESSION_EXPIRED: "Your session is too old for this. Sign in again, then retry.",
  FAILED_TO_CREATE_USER: "We couldn't create your account. Try again in a moment.",
};

/** Better Auth client errors look like `{ message, code?, status, statusText }`. */
export interface AuthClientError {
  message?: string | undefined;
  code?: string | undefined;
  status?: number | undefined;
  statusText?: string | undefined;
}

export function authErrorMessage(error: AuthClientError | null | undefined): string {
  if (!error) return "Something went wrong. Try again.";
  if (error.status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (error.code && AUTH_MESSAGES[error.code]) return AUTH_MESSAGES[error.code] as string;
  if (error.status === 403 && /verif/i.test(error.message ?? "")) {
    return AUTH_MESSAGES.EMAIL_NOT_VERIFIED as string;
  }
  if (error.message) return error.message;
  return "Something went wrong. Try again.";
}

/** A human-readable message for any error thrown by a Convex call or fetch. */
export function errorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  const data = appError(error);
  if (data) {
    if (data.code === "LIMIT_REACHED") return `${data.message} Upgrade to Pro for more.`;
    if (data.code === "FEATURE_UNAVAILABLE") return `${data.message}`;
    if (data.code === "RATE_LIMITED") return "You're going a bit fast. Try again in a moment.";
    return data.message;
  }
  if (error instanceof Error) {
    // Convex wraps server errors as "[CONVEX ...] Server Error ..." without useful detail.
    if (/Server Error/i.test(error.message)) return fallback;
    if (/Failed to fetch|NetworkError/i.test(error.message)) {
      return "We couldn't reach Desyn. Check your connection and try again.";
    }
    return error.message || fallback;
  }
  return fallback;
}
