import {
  CREDIT_ACTIONS,
  type CreditAction,
  type FairUse,
  FEATURE_KEYS,
  type FeatureKey,
  LIMIT_KEYS,
  type LimitKey,
  PLAN_IDS,
  type Plan,
  type PlanId,
  PLANS as SCHEMA_PLANS,
  isFeatureKey as schemaIsFeatureKey,
  isPlanId as schemaIsPlanId,
} from "@desyn/schema/plans";

// config/plans.json is the single source of truth for limits, features, credit costs and fair use.
// It is read through @desyn/schema (the same loader every client uses); this module adapts it to the
// shapes the backend uses (plans keyed by id, a credit-cost table that accepts arbitrary kinds).

export type { FairUse, FeatureKey, LimitKey, Plan, PlanId };
export type CreditCostKey = CreditAction;
export type PlanLimits = Plan["limits"];
export type PlanFeatures = Plan["features"];

export { CREDIT_ACTIONS, FEATURE_KEYS, LIMIT_KEYS, PLAN_IDS };

export const PLANS: Record<PlanId, Plan> = SCHEMA_PLANS.plans;
export const CREDIT_COSTS: Record<CreditCostKey, number> = SCHEMA_PLANS.creditCosts;
export const FAIR_USE: FairUse = SCHEMA_PLANS.fairUse;

export function isPlanId(value: unknown): value is PlanId {
  return schemaIsPlanId(value);
}

export function isFeatureKey(value: string): value is FeatureKey {
  return schemaIsFeatureKey(value);
}

/** Credit cost for a kind, or undefined for kinds that are not in config/plans.json. */
export function creditCost(kind: string): number | undefined {
  return Object.hasOwn(CREDIT_COSTS, kind) ? CREDIT_COSTS[kind as CreditCostKey] : undefined;
}
