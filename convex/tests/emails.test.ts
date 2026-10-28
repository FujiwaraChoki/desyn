import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { retryDelayMs } from "../emails/queue";
import { escapeHtml, formatMoney, renderTemplate } from "../emails/templates";
import { logTransport, sesTransport } from "../emails/transport";
import { setupTest } from "./harness.helpers";

describe("email templates", () => {
  test("every template renders html + text with the sun design system", () => {
    const cases = [
      renderTemplate("verifyEmail", {
        name: "Ada",
        url: "https://app.desyn.app/api/auth/verify-email?token=t",
      }),
      renderTemplate("verifyEmail", {
        url: "https://x.test/v",
        purpose: "changeEmail",
        newEmail: "new@x.test",
      }),
      renderTemplate("magicLink", {
        url: "https://app.desyn.app/api/auth/magic-link/verify?token=t",
      }),
      renderTemplate("resetPassword", { url: "https://app.desyn.app/reset?token=t" }),
      renderTemplate("invite", {
        inviterName: "Olivia",
        workspaceName: "Studio",
        role: "editor",
        url: "https://app.desyn.app/accept/x",
        expiresAt: Date.UTC(2026, 9, 27),
      }),
      renderTemplate("welcome", { name: "Ada Lovelace", url: "https://app.desyn.app/" }),
      renderTemplate("receipt", {
        planName: "Pro",
        amount: 8000,
        currency: "usd",
        interval: "year",
        url: "https://app.desyn.app/settings/billing",
      }),
      renderTemplate("planChanged", {
        fromPlan: "Free",
        toPlan: "Pro",
        url: "https://app.desyn.app/settings/billing",
      }),
      renderTemplate("exportReady", {
        designName: "Launch poster",
        format: "pdf",
        url: "https://cdn.desyn.app/e/1.pdf",
      }),
      renderTemplate("paymentFailed", {
        url: "https://app.desyn.app/settings/billing",
        amount: 800,
        currency: "eur",
      }),
    ];
    for (const email of cases) {
      expect(email.subject.length).toBeGreaterThan(5);
      expect(email.html).toContain("<!doctype html>");
      expect(email.html).toContain('name="color-scheme" content="dark light"');
      expect(email.html).toContain("prefers-color-scheme: light");
      expect(email.html).toContain("Instrument Serif");
      expect(email.html).toContain("#FFB02E");
      expect(email.text).toContain("Desyn");
      expect(email.text).not.toContain("<");
    }
    expect(cases[0]?.text).toContain("https://app.desyn.app/api/auth/verify-email?token=t");
    expect(cases[0]?.text).toContain("Hi Ada,");
    expect(cases[4]?.subject).toBe("Olivia invited you to Studio on Desyn");
    expect(cases[4]?.text).toContain("Role: Editor");
    expect(cases[6]?.subject).toBe("Your Desyn receipt · $80.00");
    expect(cases[7]?.subject).toBe("You're on Desyn Pro");
  });

  test("user content is escaped and unsafe links are refused", () => {
    const email = renderTemplate("invite", {
      inviterName: '<script>alert("x")</script>',
      workspaceName: "A & B",
      role: "viewer",
      url: "https://app.desyn.app/accept/t",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("A &amp; B");
    expect(() => renderTemplate("magicLink", { url: "javascript:alert(1)" })).toThrow(/http/);
    expect(() => renderTemplate("invite", { url: "https://x.test" })).toThrow(/inviterName/);
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
    expect(formatMoney(800, "usd")).toBe("$8.00");
  });
});

describe("mail queue and delivery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("log transport delivers, marks sent and drops the body", async () => {
    vi.stubEnv("MAIL_TRANSPORT", "log");
    const t = setupTest();
    const id = await t.mutation(internal.emails.queue.enqueue, {
      to: "Someone@Example.com",
      template: "welcome",
      data: { name: "Someone", url: "https://app.desyn.app/" },
    });
    if (!id) throw new Error("not queued");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await t.action(internal.emails.send.deliver, { mailLogId: id });
    const log = await t.run(async (ctx) => ctx.db.get("mailLog", id));
    expect(log).toMatchObject({
      status: "sent",
      transport: "log",
      to: "someone@example.com",
      attempts: 1,
    });
    expect(await t.run(async (ctx) => ctx.db.query("mailOutbox").collect())).toHaveLength(0);
    // Re-delivering a sent message is a no-op.
    await t.action(internal.emails.send.deliver, { mailLogId: id });
    expect((await t.run(async (ctx) => ctx.db.get("mailLog", id)))?.attempts).toBe(1);
  });

  test("failures are recorded and retried with backoff, then abandoned", async () => {
    vi.stubEnv("MAIL_TRANSPORT", "smtp"); // no SMTP_URL -> every attempt fails
    vi.useFakeTimers();
    const t = setupTest();
    const id = await t.mutation(internal.emails.queue.enqueue, {
      to: "x@example.com",
      template: "magicLink",
      data: { url: "https://app.desyn.app/m" },
    });
    if (!id) throw new Error("not queued");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const log = await t.run(async (ctx) => ctx.db.get("mailLog", id));
    expect(log).toMatchObject({ status: "failed", attempts: 4 });
    expect(log?.error).toContain("SMTP_URL");
    expect(await t.run(async (ctx) => ctx.db.query("mailOutbox").collect())).toHaveLength(0);
    expect(retryDelayMs(1)).toBe(15_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(10)).toBe(30 * 60_000);
  });

  test("per-recipient limit suppresses floods; idempotency keys dedupe", async () => {
    const t = setupTest();
    const ids = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        await t.mutation(internal.emails.queue.enqueue, {
          to: "flood@example.com",
          template: "magicLink",
          data: { url: "https://app.desyn.app/m" },
        }),
      );
    }
    const logs = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    expect(logs.filter((l) => l.status === "queued")).toHaveLength(10);
    expect(logs.filter((l) => l.status === "suppressed")).toHaveLength(2);
    const first = await t.mutation(internal.emails.queue.enqueue, {
      to: "r@example.com",
      template: "receipt",
      data: { planName: "Pro", amount: 800, currency: "usd", url: "https://app.desyn.app/b" },
      idempotencyKey: "receipt:in_1",
    });
    const second = await t.mutation(internal.emails.queue.enqueue, {
      to: "r@example.com",
      template: "receipt",
      data: { planName: "Pro", amount: 800, currency: "usd", url: "https://app.desyn.app/b" },
      idempotencyKey: "receipt:in_1",
    });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });
});

describe("transports", () => {
  test("SES adapter sends a multipart message through the SESv2 client", async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return { MessageId: "ses-123" };
      },
    };
    const transport = sesTransport({ from: "Desyn <hello@desyn.app>", client: client as never });
    const result = await transport.send({
      to: "a@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(result.messageId).toBe("ses-123");
    expect(sent[0]).toMatchObject({
      FromEmailAddress: "Desyn <hello@desyn.app>",
      Destination: { ToAddresses: ["a@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Hi" },
          Body: { Html: { Data: "<p>Hi</p>" }, Text: { Data: "Hi" } },
        },
      },
    });
  });

  test("log transport writes structured JSON", async () => {
    const lines: string[] = [];
    await logTransport((l) => lines.push(l)).send({
      to: "a@example.com",
      subject: "S",
      html: "<p/>",
      text: "T",
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      to: "a@example.com",
      subject: "S",
      text: "T",
    });
  });
});
