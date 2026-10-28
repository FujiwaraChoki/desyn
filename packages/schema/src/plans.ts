// Typed access to config/plans.json, the single source of truth for limits, features and credit costs.
import plansJson from "../../../config/plans.json" with { type: "json" };

type RawPlans = typeof plansJson;

export type PlanId = keyof RawPlans["plans"];
/** Every feature flag key, derived from the explicit feature map of the free plan. */
export type FeatureKey = keyof RawPlans["plans"]["free"]["features"];
export type LimitKey = keyof RawPlans["plans"]["free"]["limits"];
export type CreditAction = keyof RawPlans["creditCosts"];
export type Edition = "hosted" | "selfhost";

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: number;
  priceYearly?: number;
  /** `null` means unlimited. */
  limits: Record<LimitKey, number | null>;
  /** "ALL_TRUE" expanded to a full map. */
  features: Record<FeatureKey, boolean>;
}

export interface FairUse {
  softLimitBehavior: string;
  throttleDelayMs: [number, number];
  noOverageCharges: boolean;
  byokBypassesCredits: boolean;
  perMinuteAiRequests: number;
  perDayAiRequests: number;
  maxConcurrentRuns: number;
  maxCollaboratorsPerDesign: number;
  abuseSignals: string[];
}

export interface Plans {
  version: number;
  currency: string;
  plans: Record<PlanId, Plan>;
  creditCosts: Record<CreditAction, number>;
  fairUse: FairUse;
}

export const PLAN_IDS = Object.keys(plansJson.plans) as PlanId[];
export const FEATURE_KEYS = Object.keys(plansJson.plans.free.features) as FeatureKey[];
export const LIMIT_KEYS = Object.keys(plansJson.plans.free.limits) as LimitKey[];
export const CREDIT_ACTIONS = Object.keys(plansJson.creditCosts) as CreditAction[];

function expandFeatures(raw: unknown, planId: string): Record<FeatureKey, boolean> {
  if (raw === "ALL_TRUE") {
    return Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Record<FeatureKey, boolean>;
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`plans.json: plan "${planId}" has invalid features`);
  }
  const map = raw as Record<string, unknown>;
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) out[k] = map[k] === true;
  return out;
}

function expandLimits(
  raw: Record<string, unknown>,
  planId: string,
): Record<LimitKey, number | null> {
  const out = {} as Record<LimitKey, number | null>;
  for (const k of LIMIT_KEYS) {
    const v = raw[k];
    if (v !== null && typeof v !== "number") {
      throw new Error(`plans.json: plan "${planId}" limit "${k}" must be a number or null`);
    }
    out[k] = v;
  }
  return out;
}

function load(): Plans {
  const plans = {} as Record<PlanId, Plan>;
  for (const id of PLAN_IDS) {
    const raw = plansJson.plans[id] as {
      name: string;
      priceMonthly: number;
      priceYearly?: number;
      limits: Record<string, unknown>;
      features: unknown;
    };
    const plan: Plan = {
      id,
      name: raw.name,
      priceMonthly: raw.priceMonthly,
      limits: expandLimits(raw.limits, id),
      features: expandFeatures(raw.features, id),
    };
    if (raw.priceYearly !== undefined) plan.priceYearly = raw.priceYearly;
    plans[id] = plan;
  }
  const fairUse = plansJson.fairUse as FairUse;
  return {
    version: plansJson.version,
    currency: plansJson.currency,
    plans,
    creditCosts: { ...plansJson.creditCosts },
    fairUse,
  };
}

export const PLANS: Plans = load();

export function getPlan(planId: PlanId): Plan {
  return PLANS.plans[planId];
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.hasOwn(PLANS.plans, value);
}

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && (FEATURE_KEYS as string[]).includes(value);
}

/** Whether the plan includes a feature. */
export function can(planId: PlanId, feature: FeatureKey): boolean {
  return PLANS.plans[planId].features[feature];
}

/** The plan's limit for `key`; `null` means unlimited. */
export function limit(planId: PlanId, key: LimitKey): number | null {
  return PLANS.plans[planId].limits[key];
}

/** True when `used` (after the action) stays within the plan's limit. */
export function withinLimit(planId: PlanId, key: LimitKey, used: number): boolean {
  const max = limit(planId, key);
  return max === null || used <= max;
}

/** Credits an action costs. */
export function creditCost(action: CreditAction): number {
  return PLANS.creditCosts[action];
}

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface SubscriptionInfo {
  plan: PlanId;
  status: SubscriptionStatus;
  /** ms epoch; access continues until this moment even after cancellation. */
  currentPeriodEnd?: number;
}

/** Stripe statuses that keep paid access (past_due keeps access while Stripe retries the payment). */
const ENTITLED: ReadonlySet<SubscriptionStatus> = new Set(["active", "trialing", "past_due"]);

/**
 * Effective plan. Self-hosted editions get every feature (`selfhost`); hosted users get their subscribed plan
 * while the subscription is entitled (or a canceled one has not reached its period end), otherwise `free`.
 */
export function planForEdition(
  edition: Edition,
  subscription?: SubscriptionInfo | null,
  now: number = Date.now(),
): PlanId {
  if (edition === "selfhost") return "selfhost";
  if (!subscription || subscription.plan === "selfhost") return "free";
  if (ENTITLED.has(subscription.status)) return subscription.plan;
  if (
    subscription.status === "canceled" &&
    subscription.currentPeriodEnd !== undefined &&
    now < subscription.currentPeriodEnd
  ) {
    return subscription.plan;
  }
  return "free";
}

/** Reads `DESYN_EDITION` semantics from a raw value: anything but "hosted" is a self-hosted edition. */
export function parseEdition(value: string | undefined | null): Edition {
  return value === "hosted" ? "hosted" : "selfhost";
}
