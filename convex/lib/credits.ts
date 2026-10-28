import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getPlan } from "./entitlements";
import { errors } from "./errors";
import { creditCost, FAIR_USE, PLANS, type PlanId } from "./plans";
import { rateLimiter } from "./rateLimits";
import { incrementUsage, periodOf } from "./usage";

type DbCtx = QueryCtx | MutationCtx;

// Credits ledger with reservations and fair-use throttling.
//
// Flow for every billable AI request:
//   const r = await reserveCredits(ctx, { userId, kind: "ai.image", refId: runId });
//   if (r.status === "rate_limited") -> tell the client to retry after r.retryAfterMs
//   if (r.status === "no_credits")   -> the plan has no credit pool (Free); suggest upgrade / BYOK
//   if (r.status === "reserved")     -> wait r.delayMs (soft throttle, 0 normally), run the request
//   on success: commitCredits(ctx, { refId, cost? })   on failure: refundCredits(ctx, { refId })
// All three are idempotent by refId. Past the monthly pool users are throttled (delay hint) and the
// excess is recorded as `overage`, which is never billed.

/** Reservations older than this are considered abandoned and released by the cron. */
export const STALE_RESERVATION_MS = 60 * 60 * 1000;
/** Wait hint returned when the concurrent-run cap is hit. */
export const CONCURRENCY_RETRY_MS = 5_000;

export interface BalanceView {
  period: string;
  plan: PlanId;
  /** null = unlimited (self-host). */
  granted: number | null;
  used: number;
  reserved: number;
  overage: number;
  /** granted - used - reserved, floored at 0; null when unlimited. */
  remaining: number | null;
  /** True when the pool is exhausted and requests are being throttled. */
  throttled: boolean;
}

export type ReserveResult =
  | {
      status: "reserved";
      refId: string;
      amount: number;
      /** Soft-throttle hint: wait this long before running the request (0 when within the pool). */
      delayMs: number;
      throttled: boolean;
      byok: boolean;
      remaining: number | null;
      /** True when the refId was already reserved/settled (idempotent replay). */
      existing: boolean;
      state: "reserved" | "committed" | "refunded";
    }
  | { status: "rate_limited"; retryAfterMs: number; scope: "minute" | "day" | "concurrency" }
  | { status: "no_credits"; plan: PlanId };

export type SettleResult = {
  refId: string;
  state: "committed" | "refunded";
  charged: number;
  overage: number;
  /** True when this call changed nothing because the reservation was already in this state. */
  replay: boolean;
};

export function grantForPlan(plan: PlanId): number | null {
  return PLANS[plan].limits.creditsPerMonth;
}

function remainingOf(
  b: Pick<Doc<"creditBalances">, "granted" | "used" | "reserved">,
): number | null {
  if (b.granted === null) return null;
  return Math.max(0, b.granted - b.used - b.reserved);
}

function settledRemaining(b: Pick<Doc<"creditBalances">, "granted" | "used">): number | null {
  return b.granted === null ? null : b.granted - b.used;
}

/**
 * Soft-throttle delay once the pool is exhausted. Linear from throttleDelayMs[0] at the first credit
 * over the pool to throttleDelayMs[1] at 50% over, capped there. Zero while within the pool.
 */
export function computeThrottleDelay(input: {
  granted: number | null;
  used: number;
  reserved: number;
  cost: number;
}): number {
  const { granted, used, reserved, cost } = input;
  if (granted === null || granted <= 0) return 0;
  const after = used + reserved + cost;
  if (after <= granted) return 0;
  const [minDelay, maxDelay] = FAIR_USE.throttleDelayMs;
  const overRatio = Math.min(1, (after - granted) / (granted * 0.5));
  return Math.round(minDelay + (maxDelay - minDelay) * overRatio);
}

async function findBalance(
  ctx: DbCtx,
  userId: string,
  period: string,
): Promise<Doc<"creditBalances"> | null> {
  return await ctx.db
    .query("creditBalances")
    .withIndex("by_user_period", (q) => q.eq("userId", userId).eq("period", period))
    .unique();
}

/** Read-only balance view (works in queries; a missing row shows the plan's full grant). */
export async function getBalance(
  ctx: DbCtx,
  userId: string,
  now = Date.now(),
): Promise<BalanceView> {
  const period = periodOf(now);
  const plan = await getPlan(ctx, userId);
  const row = await findBalance(ctx, userId, period);
  const granted = row ? row.granted : grantForPlan(plan);
  const used = row?.used ?? 0;
  const reserved = row?.reserved ?? 0;
  const remaining = remainingOf({ granted, used, reserved });
  return {
    period,
    plan,
    granted,
    used,
    reserved,
    overage: row?.overage ?? 0,
    remaining,
    throttled: granted !== null && granted > 0 && remaining === 0,
  };
}

async function appendLedger(
  ctx: MutationCtx,
  entry: Omit<Doc<"credits">, "_id" | "_creationTime" | "createdAt">,
): Promise<void> {
  await ctx.db.insert("credits", { ...entry, createdAt: Date.now() });
}

/**
 * Get (or open) the balance row for the current period. Opening a period grants the plan's monthly
 * credits; when the plan changed mid-period to one with a larger pool, the grant is topped up.
 */
export async function ensureBalance(
  ctx: MutationCtx,
  userId: string,
  now = Date.now(),
): Promise<Doc<"creditBalances">> {
  const period = periodOf(now);
  const plan = await getPlan(ctx, userId);
  const planGrant = grantForPlan(plan);
  const existing = await findBalance(ctx, userId, period);
  if (existing) {
    const needsTopUp =
      existing.granted !== null && (planGrant === null || planGrant > existing.granted);
    if (!needsTopUp && existing.plan === plan) return existing;
    const patch: Partial<Doc<"creditBalances">> = { plan, updatedAt: Date.now() };
    if (needsTopUp) {
      patch.granted = planGrant;
      const delta = planGrant === null ? 0 : planGrant - (existing.granted ?? 0);
      await appendLedger(ctx, {
        userId,
        period,
        delta,
        reason: "grant",
        note: `plan:${plan}`,
        balanceAfter: planGrant === null ? null : planGrant - existing.used,
      });
    }
    await ctx.db.patch("creditBalances", existing._id, patch);
    return { ...existing, ...patch } as Doc<"creditBalances">;
  }
  const id = await ctx.db.insert("creditBalances", {
    userId,
    period,
    plan,
    granted: planGrant,
    used: 0,
    reserved: 0,
    overage: 0,
    updatedAt: Date.now(),
  });
  if (planGrant !== null && planGrant > 0) {
    await appendLedger(ctx, {
      userId,
      period,
      delta: planGrant,
      reason: "grant",
      note: `plan:${plan}`,
      balanceAfter: planGrant,
    });
  }
  const doc = await ctx.db.get("creditBalances", id);
  if (!doc) throw new Error("credit balance insert failed");
  return doc;
}

async function findReservation(
  ctx: DbCtx,
  refId: string,
): Promise<Doc<"creditReservations"> | null> {
  return await ctx.db
    .query("creditReservations")
    .withIndex("by_refId", (q) => q.eq("refId", refId))
    .unique();
}

export function costFor(kind: string, cost?: number): number {
  if (cost !== undefined) {
    if (!Number.isFinite(cost) || cost < 0)
      throw errors.invalid("Credit cost must be >= 0", "cost");
    return cost;
  }
  const fromTable = creditCost(kind);
  if (fromTable === undefined) throw errors.invalid(`Unknown credit kind ${kind}`, "kind");
  return fromTable;
}

async function activeReservationCount(ctx: DbCtx, userId: string, now: number): Promise<number> {
  const active = await ctx.db
    .query("creditReservations")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "reserved"))
    .collect();
  return active.filter((r) => now - r.createdAt < STALE_RESERVATION_MS).length;
}

/** Reserve credits for a request. Idempotent by `refId`. See the module comment for the flow. */
export async function reserveCredits(
  ctx: MutationCtx,
  args: { userId: string; kind: string; refId: string; cost?: number; byok?: boolean },
): Promise<ReserveResult> {
  if (!args.refId || args.refId.length > 200) throw errors.invalid("refId is required", "refId");
  const amount = costFor(args.kind, args.cost);
  const existing = await findReservation(ctx, args.refId);
  if (existing) {
    if (existing.userId !== args.userId) throw errors.conflict("refId belongs to another user");
    const balance = await getBalance(ctx, args.userId);
    return {
      status: "reserved",
      refId: existing.refId,
      amount: existing.amount,
      delayMs: 0,
      throttled: false,
      byok: existing.byok,
      remaining: balance.remaining,
      existing: true,
      state: existing.status,
    };
  }

  const now = Date.now();
  const plan = await getPlan(ctx, args.userId);
  const byok = Boolean(args.byok) && FAIR_USE.byokBypassesCredits;
  const unlimited = plan === "selfhost";

  if (!unlimited) {
    // Hard caps (per minute / per day / concurrent) apply to every hosted request, BYOK included.
    if ((await activeReservationCount(ctx, args.userId, now)) >= FAIR_USE.maxConcurrentRuns) {
      return { status: "rate_limited", retryAfterMs: CONCURRENCY_RETRY_MS, scope: "concurrency" };
    }
    const minute = await rateLimiter.limit(ctx, "aiPerMinute", { key: args.userId });
    if (!minute.ok) {
      return {
        status: "rate_limited",
        retryAfterMs: Math.ceil(minute.retryAfter),
        scope: "minute",
      };
    }
    const day = await rateLimiter.limit(ctx, "aiPerDay", { key: args.userId });
    if (!day.ok) {
      return { status: "rate_limited", retryAfterMs: Math.ceil(day.retryAfter), scope: "day" };
    }
  }

  const balance = await ensureBalance(ctx, args.userId, now);
  const held = byok ? 0 : amount;
  let delayMs = 0;
  if (!byok && !unlimited && balance.granted !== null) {
    if (balance.granted <= 0) return { status: "no_credits", plan };
    delayMs = computeThrottleDelay({
      granted: balance.granted,
      used: balance.used,
      reserved: balance.reserved,
      cost: amount,
    });
  }

  await ctx.db.insert("creditReservations", {
    refId: args.refId,
    userId: args.userId,
    period: balance.period,
    kind: args.kind,
    amount: held,
    byok,
    status: "reserved",
    createdAt: now,
  });
  const reserved = balance.reserved + held;
  await ctx.db.patch("creditBalances", balance._id, { reserved, updatedAt: now });
  await incrementUsage(ctx, args.userId, "aiRequests", 1, { ts: now });

  return {
    status: "reserved",
    refId: args.refId,
    amount: held,
    delayMs,
    throttled: delayMs > 0,
    byok,
    remaining: remainingOf({ granted: balance.granted, used: balance.used, reserved }),
    existing: false,
    state: "reserved",
  };
}

/**
 * Settle a reservation with the final cost (defaults to the reserved amount). Charges what still fits
 * in the pool; the rest is recorded as overage (never billed). Idempotent by refId.
 */
export async function commitCredits(
  ctx: MutationCtx,
  args: { refId: string; cost?: number },
): Promise<SettleResult> {
  const reservation = await findReservation(ctx, args.refId);
  if (!reservation) throw errors.notFound("Credit reservation");
  if (reservation.status === "committed") {
    return {
      refId: args.refId,
      state: "committed",
      charged: reservation.charged ?? 0,
      overage: (reservation.cost ?? 0) - (reservation.charged ?? 0),
      replay: true,
    };
  }
  if (reservation.status === "refunded") {
    throw errors.conflict("This credit reservation was already refunded.");
  }
  const now = Date.now();
  const cost = reservation.byok
    ? 0
    : args.cost === undefined
      ? reservation.amount
      : costFor("", args.cost);
  const balance = await findBalance(ctx, reservation.userId, reservation.period);
  let charged = cost;
  let overage = 0;
  if (balance) {
    const reservedAfter = Math.max(0, balance.reserved - reservation.amount);
    if (balance.granted !== null) {
      const room = Math.max(0, balance.granted - balance.used - reservedAfter);
      charged = Math.min(cost, room);
      overage = cost - charged;
    }
    const used = balance.used + charged;
    await ctx.db.patch("creditBalances", balance._id, {
      reserved: reservedAfter,
      used,
      overage: balance.overage + overage,
      updatedAt: now,
    });
    if (cost > 0) {
      await appendLedger(ctx, {
        userId: reservation.userId,
        period: reservation.period,
        delta: -charged,
        reason: "commit",
        refId: reservation.refId,
        kind: reservation.kind,
        ...(overage > 0 ? { note: `overage:${overage}` } : {}),
        balanceAfter: settledRemaining({ granted: balance.granted, used }),
      });
    }
  }
  await ctx.db.patch("creditReservations", reservation._id, {
    status: "committed",
    cost,
    charged,
    settledAt: now,
  });
  return { refId: args.refId, state: "committed", charged, overage, replay: false };
}

/**
 * Release a reservation, or give back the charge of a committed one (e.g. the result turned out
 * unusable). Idempotent by refId.
 */
export async function refundCredits(
  ctx: MutationCtx,
  args: { refId: string; reason?: string },
): Promise<SettleResult> {
  const reservation = await findReservation(ctx, args.refId);
  if (!reservation) throw errors.notFound("Credit reservation");
  if (reservation.status === "refunded") {
    return { refId: args.refId, state: "refunded", charged: 0, overage: 0, replay: true };
  }
  const now = Date.now();
  const balance = await findBalance(ctx, reservation.userId, reservation.period);
  if (balance) {
    if (reservation.status === "reserved") {
      await ctx.db.patch("creditBalances", balance._id, {
        reserved: Math.max(0, balance.reserved - reservation.amount),
        updatedAt: now,
      });
    } else {
      const charged = reservation.charged ?? 0;
      const overage = (reservation.cost ?? 0) - charged;
      const used = Math.max(0, balance.used - charged);
      await ctx.db.patch("creditBalances", balance._id, {
        used,
        overage: Math.max(0, balance.overage - overage),
        updatedAt: now,
      });
      if (charged > 0) {
        await appendLedger(ctx, {
          userId: reservation.userId,
          period: reservation.period,
          delta: charged,
          reason: "refund",
          refId: reservation.refId,
          kind: reservation.kind,
          ...(args.reason ? { note: args.reason.slice(0, 200) } : {}),
          balanceAfter: settledRemaining({ granted: balance.granted, used }),
        });
      }
    }
  }
  await ctx.db.patch("creditReservations", reservation._id, { status: "refunded", settledAt: now });
  return { refId: args.refId, state: "refunded", charged: 0, overage: 0, replay: false };
}

/** Admin/support adjustment of the current period's grant (positive adds credits). */
export async function adjustCredits(
  ctx: MutationCtx,
  args: { userId: string; delta: number; note: string },
): Promise<BalanceView> {
  const balance = await ensureBalance(ctx, args.userId);
  if (balance.granted === null) return await getBalance(ctx, args.userId);
  const granted = Math.max(0, balance.granted + args.delta);
  await ctx.db.patch("creditBalances", balance._id, { granted, updatedAt: Date.now() });
  await appendLedger(ctx, {
    userId: args.userId,
    period: balance.period,
    delta: granted - balance.granted,
    reason: "adjust",
    note: args.note.slice(0, 200),
    balanceAfter: granted - balance.used,
  });
  return await getBalance(ctx, args.userId);
}
