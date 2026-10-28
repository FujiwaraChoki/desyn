import { describe, expect, it } from "vitest";
import { analyticsPlan, parseConsent, readAnalyticsConfig, serializeConsent } from "./consent";

describe("consent", () => {
  const cfg = readAnalyticsConfig({
    NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
    NEXT_PUBLIC_DATAFAST_WEBSITE_ID: "dfid",
    NEXT_PUBLIC_DATAFAST_DOMAIN: "desyn.app",
  });
  it("round-trips a stored choice", () => {
    expect(parseConsent(serializeConsent("granted", 5))?.choice).toBe("granted");
    expect(parseConsent("{bad")).toBeNull();
  });
  it("keeps PostHog cookieless and DataFast off until consent", () => {
    expect(analyticsPlan(cfg, null)).toEqual({
      posthog: true,
      posthogPersistence: "memory",
      datafast: false,
      showBanner: true,
    });
    expect(analyticsPlan(cfg, "granted").datafast).toBe(true);
    expect(analyticsPlan(cfg, "denied").datafast).toBe(false);
  });
  it("disables everything when unconfigured", () => {
    expect(analyticsPlan(readAnalyticsConfig({}), null).showBanner).toBe(false);
  });
});
