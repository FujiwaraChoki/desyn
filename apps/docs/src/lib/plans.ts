import { readFileSync } from "node:fs";
import { repoPath } from "./paths.ts";

/**
 * Typed view of config/plans.json, the single source of truth for limits, features and credit
 * costs. The docs read it at build time so published numbers always match the product.
 */
export type PlanId = "free" | "pro" | "selfhost";

export interface PlanLimits {
  designs: number | null;
  pagesPerDesign: number | null;
  storageMb: number | null;
  uploadMbPerFile: number | null;
  collaboratorsPerDesign: number | null;
  brandKits: number | null;
  workspaces: number | null;
  exportsPerMonth: number | null;
  versionHistoryDays: number | null;
  creditsPerMonth: number | null;
}

export interface Plan {
  name: string;
  priceMonthly: number;
  priceYearly?: number;
  limits: PlanLimits;
  features: Record<string, boolean> | "ALL_TRUE";
}

export interface PlansConfig {
  version: number;
  currency: string;
  plans: Record<PlanId, Plan>;
  creditCosts: Record<string, number>;
  fairUse: {
    softLimitBehavior: string;
    throttleDelayMs: [number, number];
    noOverageCharges: boolean;
    byokBypassesCredits: boolean;
    perMinuteAiRequests: number;
    perDayAiRequests: number;
    maxConcurrentRuns: number;
    maxCollaboratorsPerDesign: number;
    abuseSignals: string[];
  };
}

let cached: PlansConfig | undefined;

export function loadPlans(): PlansConfig {
  if (!cached) {
    cached = JSON.parse(readFileSync(repoPath("config/plans.json"), "utf8")) as PlansConfig;
  }
  return cached;
}

export const PLAN_ORDER: PlanId[] = ["free", "pro", "selfhost"];

/** All feature keys, in the order they appear on the Free plan (the only explicit list). */
export function featureKeys(config: PlansConfig): string[] {
  for (const id of PLAN_ORDER) {
    const features = config.plans[id].features;
    if (features !== "ALL_TRUE") return Object.keys(features);
  }
  return [];
}

export function hasFeature(plan: Plan, key: string): boolean {
  return plan.features === "ALL_TRUE" ? true : plan.features[key] === true;
}

export function limitOf(plan: Plan, key: keyof PlanLimits): number | null {
  return plan.limits[key];
}
