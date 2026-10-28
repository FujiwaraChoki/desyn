"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { createLogger } from "../lib/logger";
import { selectTransport } from "./transport";

/** Deliver one queued email (scheduled by emails/queue.ts; retried with backoff on failure). */
export const deliver = internalAction({
  args: { mailLogId: v.id("mailLog") },
  handler: async (ctx, args): Promise<void> => {
    const log = createLogger(ctx, { fn: "emails.deliver", mailLogId: args.mailLogId });
    const claimed: boolean = await ctx.runMutation(internal.emails.queue.markSending, args);
    if (!claimed) return;
    const payload = await ctx.runQuery(internal.emails.queue.getForDelivery, args);
    if (!payload) {
      await ctx.runMutation(internal.emails.queue.markResult, {
        mailLogId: args.mailLogId,
        ok: false,
        transport: "none",
        error: "message body missing",
      });
      return;
    }
    let transportName = "none";
    try {
      const transport = selectTransport();
      transportName = transport.name;
      const result = await transport.send({
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      });
      await ctx.runMutation(internal.emails.queue.markResult, {
        mailLogId: args.mailLogId,
        ok: true,
        transport: transport.name,
        ...(result.messageId ? { providerMessageId: result.messageId } : {}),
      });
      log.info("mail sent", { template: payload.template, transport: transport.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.emails.queue.markResult, {
        mailLogId: args.mailLogId,
        ok: false,
        transport: transportName,
        error: message,
      });
      log.warn("mail send failed", { template: payload.template, error: message });
    }
    await log.flush();
  },
});
