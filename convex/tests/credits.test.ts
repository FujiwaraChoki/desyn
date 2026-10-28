import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { computeThrottleDelay, STALE_RESERVATION_MS } from "../lib/credits";
import { FAIR_USE } from "../lib/plans";
import { periodOf } from "../lib/usage";
import { createUser, errorData, setupTest, type TestConvex } from "./harness.helpers";

async function makePro(t: TestConvex, userId: string) {
  await t.run(async (ctx) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!profile) throw new Error("no profile");
    await ctx.db.patch("profiles", profile._id, { plan: "pro" });
  });
}

describe("credits ledger", () => {
  beforeEach(() => {
    vi.stubEnv("DESYN_EDITION", "hosted");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("reserve -> commit charges the pool once and is idempotent by refId", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await makePro(t, u.userId);
    const r1 = await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.image",
      refId: "run-1",
    });
    expect(r1).toMatchObject({ status: "reserved", amount: 3, delayMs: 0, existing: false });
    const replay = await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.image",
      refId: "run-1",
    });
    expect(replay).toMatchObject({ status: "reserved", existing: true, state: "reserved" });

    let balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ granted: 600, used: 0, reserved: 3, remaining: 597 });

    const c1 = await t.mutation(internal.billing.credits.commit, { refId: "run-1" });
    expect(c1).toMatchObject({ state: "committed", charged: 3, overage: 0, replay: false });
    const c2 = await t.mutation(internal.billing.credits.commit, { refId: "run-1" });
    expect(c2).toMatchObject({ state: "committed", charged: 3, replay: true });

    balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ used: 3, reserved: 0, remaining: 597 });

    const history = await u.as.query(api.billing.credits.history, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(history.page.map((e) => [e.reason, e.delta, e.balanceAfter])).toEqual([
      ["commit", -3, 597],
      ["grant", 600, 600],
    ]);
  });

  test("commit with a lower final cost releases the difference", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await makePro(t, u.userId);
    await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "agent.turn",
      refId: "r",
      cost: 10,
    });
    await t.mutation(internal.billing.credits.commit, { refId: "r", cost: 4 });
    const balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ used: 4, reserved: 0, remaining: 596 });
  });

  test("refund releases a reservation, refunds a commit, and is idempotent", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await makePro(t, u.userId);
    await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.svg",
      refId: "a",
    });
    expect(await t.mutation(internal.billing.credits.refund, { refId: "a" })).toMatchObject({
      state: "refunded",
      replay: false,
    });
    expect(await t.mutation(internal.billing.credits.refund, { refId: "a" })).toMatchObject({
      state: "refunded",
      replay: true,
    });
    expect(
      (await errorData(t.mutation(internal.billing.credits.commit, { refId: "a" }))).code,
    ).toBe("CONFLICT");

    await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.mockup",
      refId: "b",
    });
    await t.mutation(internal.billing.credits.commit, { refId: "b" });
    await t.mutation(internal.billing.credits.refund, { refId: "b", reason: "unusable result" });
    const balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ used: 0, reserved: 0, remaining: 600 });
    expect(
      (await errorData(t.mutation(internal.billing.credits.commit, { refId: "missing" }))).code,
    ).toBe("NOT_FOUND");
  });

  test("refIds cannot be reused across users", async () => {
    const t = setupTest();
    const a = await createUser(t);
    const b = await createUser(t);
    await makePro(t, a.userId);
    await makePro(t, b.userId);
    await t.mutation(internal.billing.credits.reserve, {
      userId: a.userId,
      kind: "ai.copy",
      refId: "shared",
    });
    expect(
      (
        await errorData(
          t.mutation(internal.billing.credits.reserve, {
            userId: b.userId,
            kind: "ai.copy",
            refId: "shared",
          }),
        )
      ).code,
    ).toBe("CONFLICT");
  });

  test("past the pool requests are throttled with a delay hint and overage is never charged", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await makePro(t, u.userId);
    // Use up the pool through an admin-style adjustment so the next request is over it.
    await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "x",
      refId: "big",
      cost: 599,
    });
    await t.mutation(internal.billing.credits.commit, { refId: "big" });
    const r = await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.image",
      refId: "over",
    });
    expect(r.status).toBe("reserved");
    if (r.status !== "reserved") throw new Error("unreachable");
    expect(r.throttled).toBe(true);
    expect(r.delayMs).toBeGreaterThanOrEqual(FAIR_USE.throttleDelayMs[0]);
    expect(r.delayMs).toBeLessThanOrEqual(FAIR_USE.throttleDelayMs[1]);
    const c = await t.mutation(internal.billing.credits.commit, { refId: "over" });
    expect(c).toMatchObject({ charged: 1, overage: 2 });
    const balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ used: 600, overage: 2, remaining: 0, throttled: true });
  });

  test("throttle delay grows with overage and caps at the configured maximum", () => {
    const [min, max] = FAIR_USE.throttleDelayMs;
    expect(computeThrottleDelay({ granted: 600, used: 0, reserved: 0, cost: 5 })).toBe(0);
    expect(
      computeThrottleDelay({ granted: 600, used: 600, reserved: 0, cost: 0.0001 }),
    ).toBeGreaterThanOrEqual(min);
    const mid = computeThrottleDelay({ granted: 600, used: 700, reserved: 0, cost: 0 });
    expect(mid).toBeGreaterThan(min);
    expect(mid).toBeLessThan(max);
    expect(computeThrottleDelay({ granted: 600, used: 5000, reserved: 0, cost: 1 })).toBe(max);
    expect(computeThrottleDelay({ granted: null, used: 5000, reserved: 0, cost: 1 })).toBe(0);
  });

  test("free plan has no credit pool unless the request is BYOK", async () => {
    const t = setupTest();
    const u = await createUser(t);
    const r = await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.image",
      refId: "f1",
    });
    expect(r).toEqual({ status: "no_credits", plan: "free" });
    const byok = await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.image",
      refId: "f2",
      byok: true,
    });
    expect(byok).toMatchObject({ status: "reserved", byok: true, amount: 0, delayMs: 0 });
    expect(
      await t.mutation(internal.billing.credits.commit, { refId: "f2", cost: 3 }),
    ).toMatchObject({ charged: 0 });
  });

  test("concurrent run cap and per-minute cap return rate_limited without reserving", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await makePro(t, u.userId);
    for (let i = 0; i < FAIR_USE.maxConcurrentRuns; i++) {
      await t.mutation(internal.billing.credits.reserve, {
        userId: u.userId,
        kind: "agent.turn",
        refId: `c${i}`,
      });
    }
    const blocked = await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "agent.turn",
      refId: "c-next",
    });
    expect(blocked).toMatchObject({ status: "rate_limited", scope: "concurrency" });
    // Settle them and burn the per-minute window.
    for (let i = 0; i < FAIR_USE.maxConcurrentRuns; i++) {
      await t.mutation(internal.billing.credits.commit, { refId: `c${i}` });
    }
    let last: { status: string; scope?: string } = { status: "" };
    for (let i = 0; i < FAIR_USE.perMinuteAiRequests; i++) {
      last = await t.mutation(internal.billing.credits.reserve, {
        userId: u.userId,
        kind: "ai.copy",
        refId: `m${i}`,
      });
      if (last.status === "reserved")
        await t.mutation(internal.billing.credits.commit, { refId: `m${i}` });
    }
    expect(last).toMatchObject({ status: "rate_limited", scope: "minute" });
  });

  test("self-host is unlimited and skips fair-use caps", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    const t = setupTest();
    const u = await createUser(t);
    for (let i = 0; i < FAIR_USE.maxConcurrentRuns + 2; i++) {
      const r = await t.mutation(internal.billing.credits.reserve, {
        userId: u.userId,
        kind: "ai.videoClip",
        refId: `s${i}`,
      });
      expect(r).toMatchObject({ status: "reserved", remaining: null, delayMs: 0 });
    }
    const balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ plan: "selfhost", granted: null, remaining: null });
  });

  test("stale reservations are released by the cron", async () => {
    vi.useFakeTimers();
    const t = setupTest();
    const u = await createUser(t);
    await makePro(t, u.userId);
    await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.image",
      refId: "lost",
    });
    vi.setSystemTime(Date.now() + STALE_RESERVATION_MS + 1000);
    expect(await t.mutation(internal.billing.credits.releaseStaleReservations, {})).toBe(1);
    const balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance.reserved).toBe(0);
  });

  test("rollover opens the new period with a fresh grant for Pro users only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const t = setupTest();
    const pro = await createUser(t);
    const free = await createUser(t);
    await makePro(t, pro.userId);
    await t.mutation(internal.billing.credits.reserve, {
      userId: pro.userId,
      kind: "x",
      refId: "oct",
      cost: 100,
    });
    await t.mutation(internal.billing.credits.commit, { refId: "oct" });

    vi.setSystemTime(new Date("2026-11-01T00:05:00Z"));
    const result = await t.mutation(internal.billing.credits.rollover, {});
    expect(result).toEqual({ opened: 1, done: true });
    const rows = await t.run(async (ctx) => ctx.db.query("creditBalances").collect());
    const nov = rows.filter((r) => r.period === "2026-11");
    expect(nov).toHaveLength(1);
    expect(nov[0]).toMatchObject({ userId: pro.userId, granted: 600, used: 0 });
    expect(rows.find((r) => r.period === "2026-10")).toMatchObject({ used: 100 });
    expect(rows.some((r) => r.userId === free.userId && r.period === "2026-11")).toBe(false);
    expect(periodOf()).toBe("2026-11");
    // Running it again opens nothing.
    expect(await t.mutation(internal.billing.credits.rollover, {})).toEqual({
      opened: 0,
      done: true,
    });
  });

  test("upgrading mid-period tops up the grant", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await t.mutation(internal.billing.credits.reserve, {
      userId: u.userId,
      kind: "ai.image",
      refId: "byok",
      byok: true,
    });
    let balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance.granted).toBe(0);
    await makePro(t, u.userId);
    await u.as.mutation(api.billing.credits.ensureCurrentPeriod, {});
    balance = await u.as.query(api.billing.credits.balance, {});
    expect(balance).toMatchObject({ plan: "pro", granted: 600 });
  });
});
