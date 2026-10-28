/**
 * Cookie/analytics consent. Stored in localStorage (not a cookie) so that asking for consent does
 * not itself set a cookie. Versioned so a policy change can re-ask.
 */

export const CONSENT_KEY = "desyn-consent";
export const CONSENT_VERSION = 1;

export type ConsentChoice = "granted" | "denied";

export interface ConsentRecord {
  v: number;
  choice: ConsentChoice;
  at: number;
}

export function parseConsent(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return null;
    const rec = data as Partial<ConsentRecord>;
    if (rec.v !== CONSENT_VERSION) return null;
    if (rec.choice !== "granted" && rec.choice !== "denied") return null;
    if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return null;
    return { v: rec.v, choice: rec.choice, at: rec.at };
  } catch {
    return null;
  }
}

export function serializeConsent(choice: ConsentChoice, now: number = Date.now()): string {
  return JSON.stringify({ v: CONSENT_VERSION, choice, at: now } satisfies ConsentRecord);
}

export interface AnalyticsConfig {
  posthogKey?: string;
  posthogHost: string;
  datafastWebsiteId?: string;
  datafastDomain?: string;
}

export const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

export function readAnalyticsConfig(env: Record<string, string | undefined>): AnalyticsConfig {
  const t = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
  return {
    posthogKey: t(env.NEXT_PUBLIC_POSTHOG_KEY),
    posthogHost: t(env.NEXT_PUBLIC_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST,
    datafastWebsiteId: t(env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID),
    datafastDomain: t(env.NEXT_PUBLIC_DATAFAST_DOMAIN),
  };
}

export function analyticsEnabled(cfg: AnalyticsConfig): {
  posthog: boolean;
  datafast: boolean;
  any: boolean;
} {
  const posthog = Boolean(cfg.posthogKey);
  const datafast = Boolean(cfg.datafastWebsiteId && cfg.datafastDomain);
  return { posthog, datafast, any: posthog || datafast };
}

/**
 * What may run for a given consent state.
 * - PostHog runs cookieless (memory persistence) before consent, full persistence after.
 * - DataFast sets a visitor cookie, so it only loads after consent.
 */
export function analyticsPlan(cfg: AnalyticsConfig, consent: ConsentChoice | null) {
  const on = analyticsEnabled(cfg);
  return {
    posthog: on.posthog,
    posthogPersistence:
      consent === "granted" ? ("localStorage+cookie" as const) : ("memory" as const),
    datafast: on.datafast && consent === "granted",
    showBanner: on.any && consent === null,
  };
}

/** Cookies DataFast sets on the visitor's browser (documented on /legal/cookies). */
export const DATAFAST_COOKIE_PREFIX = "datafast_";
/** PostHog's cookie and storage keys (`ph_<project key>_posthog`, ...). */
export const POSTHOG_STORAGE_PREFIX = "ph_";

/** Keys in a Storage-like key list that belong to analytics and must go when consent is withdrawn. */
export function analyticsStorageKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => k.startsWith(POSTHOG_STORAGE_PREFIX));
}

/**
 * `document.cookie` assignments that expire every cookie whose name starts with `prefix`, for the
 * current host and each parent domain (a script may have set them on `.desyn.app`), so that
 * withdrawing consent removes what was stored while it was granted.
 */
export function expireCookieAssignments(
  cookieHeader: string,
  prefix: string,
  hostname: string,
): string[] {
  const names = cookieHeader
    .split(";")
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter((name) => name.startsWith(prefix));
  const labels = hostname.split(".");
  const domains: (string | null)[] = [null];
  // Parent domains down to the registrable one (never a bare TLD).
  for (let i = 0; i < labels.length - 1; i++) domains.push(labels.slice(i).join("."));
  const out: string[] = [];
  for (const name of new Set(names)) {
    for (const domain of domains) {
      out.push(`${name}=; Max-Age=0; Path=/; SameSite=Lax${domain ? `; Domain=${domain}` : ""}`);
    }
  }
  return out;
}
