import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { mailTransportName } from "../lib/env";
import { createLogger } from "../lib/logger";
import { rateLimiter } from "../lib/rateLimits";
import { type MailTemplateId, mailTemplateValidator } from "../lib/validators";
import { renderTemplate, type TemplateData } from "./templates";

export const MAX_ATTEMPTS = 4;
/** Backoff before attempt n+1 (ms). */
export function retryDelayMs(attempt: number): number {
  return Math.min(30 * 60_000, 15_000 * 4 ** Math.max(0, attempt - 1));
}

/** Templates that must not be suppressed by the per-recipient limiter (security-critical). */
const ALWAYS_SEND: ReadonlySet<MailTemplateId> = new Set(["receipt", "paymentFailed"]);

export interface EnqueueInput<K extends MailTemplateId = MailTemplateId> {
  to: string;
  template: K;
  data: TemplateData[K] | Record<string, unknown>;
  userId?: string;
  /** When set, a second enqueue with the same key is a no-op (e.g. Stripe invoice id). */
  idempotencyKey?: string;
}

/**
 * Render and queue an email for delivery. Usable directly from any mutation (other owners import it,
 * e.g. exports call it with template "exportReady"). Returns the mailLog id, or null when
 * deduplicated by idempotency key.
 */
export async function enqueueEmail<K extends MailTemplateId>(
  ctx: MutationCtx,
  input: EnqueueInput<K>,
): Promise<Id<"mailLog"> | null> {
  const to = input.to.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("Invalid recipient address");
  if (input.idempotencyKey) {
    const existing = await ctx.db
      .query("mailLog")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", input.idempotencyKey))
      .first();
    if (existing) return null;
  }
  const rendered = renderTemplate(input.template, input.data);
  const now = Date.now();
  const base = {
    to,
    template: input.template,
    subject: rendered.subject,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    attempts: 0,
    createdAt: now,
  };
  if (!ALWAYS_SEND.has(input.template)) {
    const allowed = await rateLimiter.limit(ctx, "mailPerRecipient", { key: to });
    if (!allowed.ok) {
      const log = createLogger(ctx, { fn: "emails.enqueue" });
      log.warn("mail suppressed by recipient limit", { template: input.template });
      await log.flush();
      return await ctx.db.insert("mailLog", {
        ...base,
        status: "suppressed",
        error: "recipient rate limit",
      });
    }
  }
  const mailLogId = await ctx.db.insert("mailLog", {
    ...base,
    status: "queued",
    transport: mailTransportName(),
  });
  await ctx.db.insert("mailOutbox", {
    mailLogId,
    html: rendered.html,
    text: rendered.text,
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.emails.send.deliver, { mailLogId });
  return mailLogId;
}

export const enqueue = internalMutation({
  args: {
    to: v.string(),
    template: mailTemplateValidator,
    data: v.record(v.string(), v.any()),
    userId: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await enqueueEmail(ctx, args);
  },
});

/** Delivery payload (internal only; contains the rendered body). */
export const getForDelivery = internalQuery({
  args: { mailLogId: v.id("mailLog") },
  handler: async (ctx, args) => {
    const log = await ctx.db.get("mailLog", args.mailLogId);
    if (!log) return null;
    const outbox = await ctx.db
      .query("mailOutbox")
      .withIndex("by_mailLogId", (q) => q.eq("mailLogId", args.mailLogId))
      .unique();
    if (!outbox) return null;
    return {
      to: log.to,
      subject: log.subject,
      template: log.template,
      status: log.status,
      attempts: log.attempts,
      html: outbox.html,
      text: outbox.text,
    };
  },
});

export const markSending = internalMutation({
  args: { mailLogId: v.id("mailLog") },
  handler: async (ctx, args): Promise<boolean> => {
    const log = await ctx.db.get("mailLog", args.mailLogId);
    if (!log || (log.status !== "queued" && log.status !== "failed")) return false;
    await ctx.db.patch("mailLog", args.mailLogId, {
      status: "sending",
      attempts: log.attempts + 1,
      lastAttemptAt: Date.now(),
    });
    return true;
  },
});

async function dropOutbox(ctx: MutationCtx, mailLogId: Id<"mailLog">) {
  const outbox = await ctx.db
    .query("mailOutbox")
    .withIndex("by_mailLogId", (q) => q.eq("mailLogId", mailLogId))
    .unique();
  if (outbox) await ctx.db.delete("mailOutbox", outbox._id);
}

export const markResult = internalMutation({
  args: {
    mailLogId: v.id("mailLog"),
    ok: v.boolean(),
    transport: v.string(),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db.get("mailLog", args.mailLogId);
    if (!log) return;
    if (args.ok) {
      await ctx.db.patch("mailLog", args.mailLogId, {
        status: "sent",
        transport: args.transport,
        sentAt: Date.now(),
        ...(args.providerMessageId ? { providerMessageId: args.providerMessageId } : {}),
        error: undefined,
      });
      await dropOutbox(ctx, args.mailLogId);
      return;
    }
    const error = (args.error ?? "unknown error").slice(0, 500);
    await ctx.db.patch("mailLog", args.mailLogId, {
      status: "failed",
      transport: args.transport,
      error,
    });
    if (log.attempts < MAX_ATTEMPTS) {
      await ctx.scheduler.runAfter(retryDelayMs(log.attempts), internal.emails.send.deliver, {
        mailLogId: args.mailLogId,
      });
    } else {
      await dropOutbox(ctx, args.mailLogId);
      const logger = createLogger(ctx, { fn: "emails.markResult" });
      logger.error("mail delivery abandoned", {
        template: log.template,
        attempts: log.attempts,
        error,
      });
      await logger.flush();
    }
  },
});

/** A "sending" message whose action has not reported back for this long is considered lost. */
export const STUCK_SENDING_MS = 15 * 60 * 1000;

/**
 * Cron: recover messages whose delivery action died after claiming them (deployment restart,
 * action timeout). They are marked failed and retried like any other failure, or abandoned once
 * they used all attempts.
 */
export const recoverStuck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STUCK_SENDING_MS;
    const sending = await ctx.db
      .query("mailLog")
      .withIndex("by_status", (q) => q.eq("status", "sending"))
      .take(200);
    let retried = 0;
    let abandoned = 0;
    for (const row of sending) {
      if ((row.lastAttemptAt ?? row.createdAt) > cutoff) continue;
      await ctx.db.patch("mailLog", row._id, { status: "failed", error: "delivery timed out" });
      if (row.attempts < MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(0, internal.emails.send.deliver, { mailLogId: row._id });
        retried++;
      } else {
        await dropOutbox(ctx, row._id);
        abandoned++;
      }
    }
    return { retried, abandoned };
  },
});

/** Cron: drop mail metadata older than 90 days and any orphaned outbox bodies older than 2 days. */
export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const logCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const oldLogs = await ctx.db
      .query("mailLog")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", logCutoff))
      .take(500);
    for (const row of oldLogs) {
      await dropOutbox(ctx, row._id);
      await ctx.db.delete("mailLog", row._id);
    }
    const outboxCutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const staleOutbox = (await ctx.db.query("mailOutbox").take(500)).filter(
      (o) => o.createdAt < outboxCutoff,
    );
    for (const row of staleOutbox) await ctx.db.delete("mailOutbox", row._id);
    if (oldLogs.length === 500) await ctx.scheduler.runAfter(0, internal.emails.queue.purgeOld, {});
    return { mailLog: oldLogs.length, outbox: staleOutbox.length };
  },
});
