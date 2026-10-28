import { internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { env } from "./env";
import { redact } from "./logger";

// Server-side PostHog capture. Off unless POSTHOG_PROJECT_API_KEY (or NEXT_PUBLIC_POSTHOG_KEY) is set.
// Host defaults to the EU cloud. From mutations the capture is scheduled as an action (mutations
// cannot fetch); from actions it is sent directly.

export interface CaptureInput {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

export function posthogConfig(): { key: string; host: string } | null {
  const key = env.get("POSTHOG_PROJECT_API_KEY") ?? env.get("NEXT_PUBLIC_POSTHOG_KEY");
  if (!key) return null;
  const host = (
    env.get("POSTHOG_HOST") ??
    env.get("NEXT_PUBLIC_POSTHOG_HOST") ??
    "https://eu.i.posthog.com"
  ).replace(/\/+$/, "");
  return { key, host };
}

/** Send events to PostHog's batch endpoint. Never throws; returns false on failure. */
export async function sendToPosthog(events: CaptureInput[]): Promise<boolean> {
  const config = posthogConfig();
  if (!config) return false;
  if (events.length === 0) return true;
  try {
    const res = await fetch(`${config.host}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config.key,
        batch: events.map((e) => ({
          event: e.event,
          distinct_id: e.distinctId,
          properties: { ...(redact(e.properties ?? {}) as object), $lib: "desyn-convex" },
          timestamp: new Date().toISOString(),
        })),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Capture from a mutation (scheduled) or an action (direct). No-op when PostHog is not configured. */
export async function capture(ctx: MutationCtx | ActionCtx, input: CaptureInput): Promise<void> {
  if (!posthogConfig()) return;
  if ("db" in ctx) {
    await ctx.scheduler.runAfter(0, internal.lib.telemetry.capture, {
      events: [{ ...input, properties: input.properties ?? {} }],
    });
  } else {
    await sendToPosthog([input]);
  }
}
