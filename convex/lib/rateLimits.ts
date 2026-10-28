import { DAY, HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import { FAIR_USE } from "./plans";

/**
 * Application rate limits (the Better Auth HTTP endpoints have their own limiter in convex/auth.ts).
 * Other owners may add limits in their own `RateLimiter` instance; names must not collide.
 */
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Fair use for AI requests (config/plans.json fairUse). Keyed by userId.
  aiPerMinute: { kind: "fixed window", rate: FAIR_USE.perMinuteAiRequests, period: MINUTE },
  aiPerDay: { kind: "fixed window", rate: FAIR_USE.perDayAiRequests, period: DAY },
  // Abuse protection for account features. Keyed by userId unless noted.
  invitesPerHour: { kind: "token bucket", rate: 30, period: HOUR, capacity: 30 },
  apiKeyCreate: { kind: "token bucket", rate: 10, period: HOUR, capacity: 10 },
  workspaceCreate: { kind: "token bucket", rate: 10, period: HOUR, capacity: 10 },
  nativeAuthCode: { kind: "token bucket", rate: 20, period: HOUR, capacity: 10 },
  checkout: { kind: "token bucket", rate: 20, period: HOUR, capacity: 10 },
  // Keyed by lowercased recipient address.
  mailPerRecipient: { kind: "token bucket", rate: 10, period: HOUR, capacity: 10 },
  // Password attempts on one share link (keyed by the share token): 10 tries, then one every 90 s.
  shareUnlock: { kind: "token bucket", rate: 10, period: 15 * MINUTE, capacity: 10 },
  // Global brake on unauthenticated native token exchanges.
  nativeTokenExchange: { kind: "token bucket", rate: 600, period: MINUTE, capacity: 120 },
});
