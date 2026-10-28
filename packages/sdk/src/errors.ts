import type { ApiErrorCode } from "./contract/common";

/** An error response of the Agent API (`{ error: { code, message, … } }`) or a transport failure. */
export class DesynApiError extends Error {
  override readonly name = "DesynApiError";
  /** HTTP status (0 for network errors and timeouts). */
  readonly status: number;
  readonly code: ApiErrorCode | "NETWORK_ERROR" | "TIMEOUT" | "INVALID_RESPONSE";
  /** Extra fields of the error body (field, retryAfterMs, feature, limit, issues, …). */
  readonly details: Record<string, unknown>;
  readonly requestId: string | undefined;

  constructor(init: {
    status: number;
    code: DesynApiError["code"];
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.requestId = init.requestId;
  }

  /** Milliseconds to wait before retrying, when the server said so. */
  get retryAfterMs(): number | undefined {
    const v = this.details.retryAfterMs;
    return typeof v === "number" ? v : undefined;
  }

  /** Whether retrying the same request later can succeed. */
  get retryable(): boolean {
    return (
      this.code === "RATE_LIMITED" ||
      this.code === "UPSTREAM_UNAVAILABLE" ||
      this.code === "IDEMPOTENCY_IN_PROGRESS" ||
      this.code === "NETWORK_ERROR" ||
      this.code === "TIMEOUT" ||
      this.status >= 500
    );
  }
}
