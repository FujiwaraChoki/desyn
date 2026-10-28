import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { verifyStripeSignature } from "../billing/signature";
import { env, isHosted } from "../lib/env";
import { createLogger } from "../lib/logger";

const MAX_BODY_BYTES = 512 * 1024;

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * POST /stripe/webhook: verifies `Stripe-Signature` with STRIPE_WEBHOOK_SECRET, then processes the
 * event idempotently. Replies 2xx for handled/ignored/duplicate events so Stripe stops retrying;
 * 400 for bad signatures; 5xx when processing throws (Stripe retries).
 */
const stripeWebhook = httpAction(async (ctx, request) => {
  const log = createLogger(ctx, { route: "/stripe/webhook" });
  if (!isHosted()) return reply(404, { error: "billing disabled" });
  const secret = env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    log.error("STRIPE_WEBHOOK_SECRET is not configured");
    await log.flush();
    return reply(503, { error: "not configured" });
  }
  const payload = await request.text();
  if (payload.length > MAX_BODY_BYTES) return reply(413, { error: "payload too large" });
  const check = await verifyStripeSignature({
    payload,
    header: request.headers.get("stripe-signature"),
    secret,
  });
  if (!check.ok) {
    log.warn("stripe signature rejected", { reason: check.reason });
    await log.flush();
    return reply(400, { error: "invalid signature" });
  }
  let event: { id?: unknown; type?: unknown; created?: unknown; data?: { object?: unknown } };
  try {
    event = JSON.parse(payload);
  } catch {
    return reply(400, { error: "invalid json" });
  }
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.created !== "number"
  ) {
    return reply(400, { error: "invalid event" });
  }
  try {
    const result = await ctx.runMutation(internal.billing.webhook.processEvent, {
      id: event.id,
      type: event.type,
      created: event.created,
      object: event.data?.object ?? null,
    });
    return reply(200, { received: true, outcome: result.outcome });
  } catch (err) {
    log.error("stripe event processing failed", {
      eventId: event.id,
      type: event.type,
      error: err,
    });
    await log.flush();
    return reply(500, { error: "processing failed" });
  }
});

export function registerStripeRoutes(http: HttpRouter): void {
  http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook });
}
