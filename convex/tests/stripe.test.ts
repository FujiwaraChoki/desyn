import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { normalizeInvoice, normalizeSubscription } from "../billing/normalize";
import {
  parseSignatureHeader,
  signStripePayload,
  verifyStripeSignature,
} from "../billing/signature";
import { safeReturnPath } from "../billing/stripeActions";
import { createUser, setupTest, type TestConvex } from "./harness.helpers";

const SECRET = "whsec_test_secret_for_unit_tests_only";

function subscriptionObject(opts: {
  id?: string;
  customer: string;
  status: string;
  userId?: string;
  interval?: "month" | "year";
  cancelAtPeriodEnd?: boolean;
}) {
  return {
    id: opts.id ?? "sub_123",
    object: "subscription",
    customer: opts.customer,
    status: opts.status,
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    canceled_at: opts.status === "canceled" ? 1_790_000_000 : null,
    metadata: opts.userId ? { userId: opts.userId } : {},
    items: {
      object: "list",
      data: [
        {
          id: "si_1",
          current_period_start: 1_790_000_000,
          current_period_end: 1_792_592_000,
          price: { id: "price_pro_monthly", recurring: { interval: opts.interval ?? "month" } },
        },
      ],
    },
  };
}

async function deliver(
  t: TestConvex,
  event: Record<string, unknown>,
  opts: { sign?: boolean; secret?: string } = {},
) {
  const payload = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign !== false) {
    headers["stripe-signature"] = await signStripePayload(
      payload,
      opts.secret ?? SECRET,
      Math.floor(Date.now() / 1000),
    );
  }
  return await t.fetch("/stripe/webhook", { method: "POST", headers, body: payload });
}

let eventSeq = 0;
function event(type: string, object: unknown, created = Math.floor(Date.now() / 1000)) {
  eventSeq++;
  return { id: `evt_${eventSeq}`, object: "event", type, created, data: { object } };
}

async function linkCustomer(t: TestConvex, userId: string, customerId: string) {
  await t.run(async (ctx) => {
    const p = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!p) throw new Error("profile");
    await ctx.db.patch("profiles", p._id, { stripeCustomerId: customerId });
  });
}

describe("stripe signature verification", () => {
  test("accepts headers produced by the official Stripe SDK", async () => {
    const payload = JSON.stringify({ id: "evt_sdk", type: "invoice.paid" });
    const stripe = new Stripe("sk_test_unused");
    const timestamp = Math.floor(Date.now() / 1000);
    const header = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: SECRET,
      timestamp,
    });
    expect(await verifyStripeSignature({ payload, header, secret: SECRET })).toEqual({
      ok: true,
      timestamp,
    });
    // And the SDK accepts ours.
    const ours = await signStripePayload(payload, SECRET, timestamp);
    const parsed = await stripe.webhooks.constructEventAsync(payload, ours, SECRET);
    expect(parsed.id).toBe("evt_sdk");
  });

  test("rejects tampered payloads, wrong secrets, stale timestamps and malformed headers", async () => {
    const payload = '{"id":"evt_1"}';
    const now = 1_800_000_000;
    const header = await signStripePayload(payload, SECRET, now);
    expect(
      await verifyStripeSignature({ payload: `${payload} `, header, secret: SECRET, nowSec: now }),
    ).toMatchObject({
      ok: false,
      reason: "no_match",
    });
    expect(
      await verifyStripeSignature({ payload, header, secret: "whsec_other", nowSec: now }),
    ).toMatchObject({
      ok: false,
      reason: "no_match",
    });
    expect(
      await verifyStripeSignature({ payload, header, secret: SECRET, nowSec: now + 301 }),
    ).toMatchObject({
      ok: false,
      reason: "timestamp_out_of_range",
    });
    expect(
      await verifyStripeSignature({ payload, header: "v1=abc", secret: SECRET }),
    ).toMatchObject({
      reason: "malformed_header",
    });
    expect(await verifyStripeSignature({ payload, header: null, secret: SECRET })).toMatchObject({
      reason: "missing_header",
    });
    // Multiple v1 signatures (secret rotation): any match is enough.
    const rotated = `${header},v1=${"0".repeat(64)}`;
    expect(parseSignatureHeader(rotated)?.signatures).toHaveLength(2);
    expect(
      (await verifyStripeSignature({ payload, header: rotated, secret: SECRET, nowSec: now })).ok,
    ).toBe(true);
  });
});

describe("stripe object normalization", () => {
  test("reads periods from subscription items and invoice parent details", () => {
    const sub = normalizeSubscription(
      subscriptionObject({ customer: "cus_1", status: "active", userId: "u1" }),
    );
    expect(sub).toMatchObject({
      id: "sub_123",
      customerId: "cus_1",
      status: "active",
      interval: "month",
      priceId: "price_pro_monthly",
      currentPeriodEnd: 1_792_592_000_000,
      userId: "u1",
    });
    expect(normalizeSubscription({ id: "x", status: "weird", customer: "c" })).toBeNull();
    const inv = normalizeInvoice({
      id: "in_1",
      customer: { id: "cus_1" },
      amount_paid: 800,
      amount_due: 800,
      currency: "usd",
      attempt_count: 1,
      parent: { subscription_details: { subscription: "sub_123" } },
      lines: {
        data: [
          {
            period: { end: 1_792_592_000 },
            pricing: { price_details: { price: "price_pro_monthly" } },
          },
        ],
      },
    });
    expect(inv).toMatchObject({
      subscriptionId: "sub_123",
      amountPaid: 800,
      priceId: "price_pro_monthly",
      periodEnd: 1_792_592_000_000,
    });
  });

  test("only same-origin return paths are accepted", () => {
    expect(safeReturnPath("/settings/billing", "/x")).toBe("/settings/billing");
    expect(safeReturnPath("//evil.com", "/x")).toBe("/x");
    expect(safeReturnPath("https://evil.com", "/x")).toBe("/x");
    expect(safeReturnPath("/\\evil.com", "/x")).toBe("/x");
    expect(safeReturnPath(undefined, "/x")).toBe("/x");
  });
});

describe("stripe webhook", () => {
  beforeEach(() => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  test("rejects unsigned or mis-signed requests", async () => {
    const t = setupTest();
    expect((await deliver(t, event("invoice.paid", {}), { sign: false })).status).toBe(400);
    expect((await deliver(t, event("invoice.paid", {}), { secret: "whsec_wrong" })).status).toBe(
      400,
    );
    expect(await t.run(async (ctx) => ctx.db.query("stripeEvents").collect())).toHaveLength(0);
  });

  test("is disabled on self-host", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    const t = setupTest();
    expect((await deliver(t, event("invoice.paid", {}))).status).toBe(404);
  });

  test("subscription lifecycle drives the plan, idempotently and in order", async () => {
    const t = setupTest();
    const u = await createUser(t, { name: "Paying Customer" });
    const base = Math.floor(Date.now() / 1000);

    const created = event(
      "customer.subscription.created",
      subscriptionObject({ customer: "cus_A", status: "active", userId: u.userId }),
      base,
    );
    const res = await deliver(t, created);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "processed" });

    let me = await u.as.query(api.accounts.profiles.me, {});
    expect(me).toMatchObject({ plan: "pro", hasStripeCustomer: true });
    expect(me?.features["ai.agent"]).toBe(true);
    expect((await u.as.query(api.billing.credits.balance, {})).granted).toBe(600);
    const status = await u.as.query(api.billing.subscription.status, {});
    expect(status).toMatchObject({
      enabled: false,
      plan: "pro",
      subscription: { status: "active", interval: "month" },
    });

    // Redelivery of the same event is a no-op.
    const dup = await deliver(t, created);
    expect(await dup.json()).toEqual({ received: true, outcome: "duplicate" });

    // Cancellation arrives; then an older "updated" event arrives late and must be ignored.
    await deliver(
      t,
      event(
        "customer.subscription.deleted",
        subscriptionObject({ customer: "cus_A", status: "canceled", userId: u.userId }),
        base + 20,
      ),
    );
    const late = await deliver(
      t,
      event(
        "customer.subscription.updated",
        subscriptionObject({ customer: "cus_A", status: "active", userId: u.userId }),
        base + 10,
      ),
    );
    expect(await late.json()).toEqual({ received: true, outcome: "ignored" });
    me = await u.as.query(api.accounts.profiles.me, {});
    expect(me?.plan).toBe("free");

    const mails = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    const planMails = mails.filter((m) => m.template === "planChanged");
    expect(planMails.map((m) => m.subject)).toEqual([
      "You're on Desyn Pro",
      "Your Desyn plan is now Free",
    ]);
    const audit = await t.run(async (ctx) => ctx.db.query("audit").collect());
    expect(audit.filter((a) => a.action === "billing.planChanged")).toHaveLength(2);
  });

  test("past_due keeps Pro; unknown customers are ignored", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await linkCustomer(t, u.userId, "cus_B");
    await deliver(
      t,
      event(
        "customer.subscription.updated",
        subscriptionObject({ customer: "cus_B", status: "past_due" }),
      ),
    );
    expect((await u.as.query(api.accounts.profiles.me, {}))?.plan).toBe("pro");
    const res = await deliver(
      t,
      event(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_x", customer: "cus_unknown", status: "active" }),
      ),
    );
    expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
  });

  test("invoices send one receipt and payment-failure notices", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await linkCustomer(t, u.userId, "cus_C");
    const invoice = {
      id: "in_42",
      customer: "cus_C",
      amount_paid: 800,
      amount_due: 800,
      currency: "usd",
      attempt_count: 1,
      hosted_invoice_url: "https://invoice.stripe.com/i/acct/test",
      lines: {
        data: [
          {
            period: { end: 1_792_592_000 },
            price: { id: "price_m", recurring: { interval: "month" } },
          },
        ],
      },
    };
    await deliver(t, event("invoice.paid", invoice));
    await deliver(t, event("invoice.paid", invoice)); // different event id, same invoice
    await deliver(t, event("invoice.payment_failed", { ...invoice, id: "in_43", amount_paid: 0 }));
    await deliver(t, event("invoice.paid", { ...invoice, id: "in_zero", amount_paid: 0 }));
    const mails = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    const receipts = mails.filter((m) => m.template === "receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.subject).toBe("Your Desyn receipt · $8.00");
    expect(mails.filter((m) => m.template === "paymentFailed")).toHaveLength(1);
  });

  test("checkout completion links the customer and schedules a subscription sync", async () => {
    const t = setupTest();
    const u = await createUser(t);
    const res = await deliver(
      t,
      event("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        client_reference_id: u.userId,
        customer: "cus_D",
        subscription: "sub_D",
      }),
    );
    expect(await res.json()).toEqual({ received: true, outcome: "processed" });
    const profile = await t.run(async (ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_userId", (q) => q.eq("userId", u.userId))
        .unique(),
    );
    expect(profile?.stripeCustomerId).toBe("cus_D");
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.some(
        (s) => s.name.includes("stripeActions") && s.name.includes("syncSubscription"),
      ),
    ).toBe(true);
  });
});
