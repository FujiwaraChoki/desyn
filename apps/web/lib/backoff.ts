/*
 * Retry pacing for the session guard when the auth server answers 429 or 5xx. The attempt count
 * survives reloads (sessionStorage) so a rate-limited tab slows down instead of reloading every few
 * seconds, which would keep its IP over the auth server's per-minute budget indefinitely.
 */

export const AUTH_RETRY_KEY = "desyn-auth-retry";
const BASE_MS = 5_000;
const MAX_MS = 60_000;

/** Delay before retry number `attempt` (0-based): 5 s, 10 s, 20 s, 40 s, then 60 s, with ±20% jitter. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const base = Math.min(MAX_MS, BASE_MS * 2 ** Math.min(n, 10));
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(MAX_MS, base * jitter));
}

/** Reads and increments the persisted attempt counter; returns the attempt number to use now. */
export function nextAuthRetryAttempt(): number {
  try {
    const current = Number(sessionStorage.getItem(AUTH_RETRY_KEY) ?? "0");
    const attempt = Number.isFinite(current) && current >= 0 ? current : 0;
    sessionStorage.setItem(AUTH_RETRY_KEY, String(attempt + 1));
    return attempt;
  } catch {
    return 3;
  }
}

export function resetAuthRetry(): void {
  try {
    sessionStorage.removeItem(AUTH_RETRY_KEY);
  } catch {
    // ignore
  }
}
