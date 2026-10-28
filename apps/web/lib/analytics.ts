"use client";

/*
 * Thin client-side analytics facade. PostHog is loaded lazily by <Analytics>; until then (or when it
 * is not configured) these calls are no-ops. Never pass personal data beyond the user id.
 */

export interface PostHogLike {
  init: (key: string, options: Record<string, unknown>) => unknown;
  capture: (event: string, properties?: Record<string, unknown>) => unknown;
  identify: (distinctId: string, properties?: Record<string, unknown>) => unknown;
  reset: () => unknown;
  set_config: (config: Record<string, unknown>) => unknown;
  get_distinct_id?: () => string;
}

let client: PostHogLike | null = null;
let pendingIdentity: { id: string; props: Record<string, unknown> } | null = null;

export function setAnalyticsClient(ph: PostHogLike | null): void {
  client = ph;
  if (ph && pendingIdentity) {
    ph.identify(pendingIdentity.id, pendingIdentity.props);
    pendingIdentity = null;
  }
}

export function track(event: string, properties?: Record<string, unknown>): void {
  client?.capture(event, properties);
}

/** Links the anonymous visitor to the signed-in user (PostHog `identify`). */
export function identify(userId: string, properties: Record<string, unknown> = {}): void {
  if (client) {
    if (client.get_distinct_id?.() !== userId) client.identify(userId, properties);
  } else {
    pendingIdentity = { id: userId, props: properties };
  }
}

export function resetAnalytics(): void {
  pendingIdentity = null;
  client?.reset();
}
