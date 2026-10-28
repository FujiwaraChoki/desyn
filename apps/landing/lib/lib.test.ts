import { describe, expect, it } from "vitest";
import {
  analyticsEnabled,
  analyticsPlan,
  analyticsStorageKeys,
  CONSENT_VERSION,
  DATAFAST_COOKIE_PREFIX,
  DEFAULT_POSTHOG_HOST,
  expireCookieAssignments,
  parseConsent,
  readAnalyticsConfig,
  serializeConsent,
} from "./consent";
import { faqJsonLd, serializeJsonLd, softwareApplicationJsonLd } from "./jsonld";
import {
  comparisonRows,
  hasFeature,
  planConfig,
  planLines,
  planSummaries,
  yearlySavingsMonths,
} from "./plans";
import { absoluteUrl } from "./site";
import { resolveTheme, themeBootScript } from "./theme";

describe("plans (from config/plans.json)", () => {
  it("reads prices straight from the config", () => {
    const [free, pro, self] = planSummaries();
    expect(free?.priceMonthly).toBe(planConfig.plans.free.priceMonthly);
    expect(pro?.priceMonthly).toBe(8);
    expect(pro?.priceYearly).toBe(80);
    expect(self?.name).toBe("Self-hosted");
  });

  it("is honest that Free has no AI", () => {
    expect(hasFeature("free", "ai.agent")).toBe(false);
    const lines = planLines("free");
    const ai = lines.find((l) => l.text.startsWith("AI design agent"));
    expect(ai?.included).toBe(false);
    expect(lines.some((l) => l.text === "20 designs")).toBe(true);
    expect(lines.some((l) => l.text === "1 GB storage")).toBe(true);
    expect(lines.some((l) => l.text === "PNG, JPG, PDF export")).toBe(true);
  });

  it("lists Pro limits from the config", () => {
    const texts = planLines("pro").map((l) => l.text);
    expect(texts).toContain("600 AI credits every month");
    expect(texts).toContain("Unlimited designs");
    expect(texts).toContain("100 GB storage");
    expect(texts).toContain("90 days of version history");
    expect(planLines("pro").every((l) => l.included)).toBe(true);
  });

  it("states the self-host licence condition", () => {
    expect(planLines("selfhost").map((l) => l.text)).toContain("Non-commercial use only");
  });

  it("never reports an unknown feature key as included", () => {
    expect(hasFeature("pro", "ai.agent")).toBe(true);
    expect(hasFeature("pro", "not.a.feature")).toBe(false);
    expect(hasFeature("selfhost", "")).toBe(false);
  });

  it("reads plans through @desyn/schema (Self-hosted expands ALL_TRUE)", () => {
    expect(planConfig.plans.selfhost.features["ai.agent"]).toBe(true);
    expect(planConfig.plans.free.features["ai.agent"]).toBe(false);
  });

  it("computes yearly savings", () => {
    expect(yearlySavingsMonths("pro")).toBe(2);
    expect(yearlySavingsMonths("free")).toBe(0);
  });

  it("builds a comparison table covering every plan", () => {
    const { limits, features } = comparisonRows();
    expect(limits.find((r) => r.label === "Designs")?.values).toEqual({
      free: "20",
      pro: "Unlimited",
      selfhost: "Unlimited",
    });
    expect(features.find((r) => r.label.startsWith("AI agent"))?.values).toEqual({
      free: false,
      pro: true,
      selfhost: true,
    });
  });
});

describe("consent withdrawal", () => {
  it("expires only DataFast cookies, on the host and every parent domain", () => {
    const out = expireCookieAssignments(
      "datafast_visitor_id=abc; desyn-theme=dark; datafast_session_id=x; ph_key_posthog=1",
      DATAFAST_COOKIE_PREFIX,
      "www.desyn.app",
    );
    const names = new Set(out.map((a) => a.split("=")[0]));
    expect(names).toEqual(new Set(["datafast_visitor_id", "datafast_session_id"]));
    expect(out).toContain("datafast_visitor_id=; Max-Age=0; Path=/; SameSite=Lax");
    expect(out).toContain(
      "datafast_visitor_id=; Max-Age=0; Path=/; SameSite=Lax; Domain=www.desyn.app",
    );
    expect(out).toContain(
      "datafast_visitor_id=; Max-Age=0; Path=/; SameSite=Lax; Domain=desyn.app",
    );
    // Never a bare TLD.
    expect(out.some((a) => a.endsWith("Domain=app"))).toBe(false);
  });

  it("finds PostHog storage keys and leaves the site's own keys alone", () => {
    expect(
      analyticsStorageKeys([
        "ph_phc_x_posthog",
        "desyn-theme",
        "desyn-consent",
        "ph_phc_x_window_id",
      ]),
    ).toEqual(["ph_phc_x_posthog", "ph_phc_x_window_id"]);
  });

  it("does nothing when no DataFast cookie exists", () => {
    expect(expireCookieAssignments("", DATAFAST_COOKIE_PREFIX, "localhost")).toEqual([]);
    expect(expireCookieAssignments("a=1; b=2", DATAFAST_COOKIE_PREFIX, "desyn.app")).toEqual([]);
  });
});

describe("consent", () => {
  it("round-trips and rejects junk or old versions", () => {
    const raw = serializeConsent("granted", 123);
    expect(parseConsent(raw)).toEqual({ v: CONSENT_VERSION, choice: "granted", at: 123 });
    expect(parseConsent("nope")).toBeNull();
    expect(parseConsent(JSON.stringify({ v: 0, choice: "granted", at: 1 }))).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION, choice: "maybe", at: 1 }))).toBeNull();
    expect(parseConsent(null)).toBeNull();
  });

  it("everything is off without env vars", () => {
    const cfg = readAnalyticsConfig({});
    expect(cfg.posthogHost).toBe(DEFAULT_POSTHOG_HOST);
    expect(analyticsEnabled(cfg)).toEqual({ posthog: false, datafast: false, any: false });
    expect(analyticsPlan(cfg, null)).toMatchObject({
      posthog: false,
      datafast: false,
      showBanner: false,
    });
  });

  it("PostHog stays cookieless and DataFast stays off until consent", () => {
    const cfg = readAnalyticsConfig({
      NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
      NEXT_PUBLIC_DATAFAST_WEBSITE_ID: "df_test",
      NEXT_PUBLIC_DATAFAST_DOMAIN: "desyn.app",
    });
    expect(analyticsPlan(cfg, null)).toEqual({
      posthog: true,
      posthogPersistence: "memory",
      datafast: false,
      showBanner: true,
    });
    expect(analyticsPlan(cfg, "denied")).toEqual({
      posthog: true,
      posthogPersistence: "memory",
      datafast: false,
      showBanner: false,
    });
    expect(analyticsPlan(cfg, "granted")).toEqual({
      posthog: true,
      posthogPersistence: "localStorage+cookie",
      datafast: true,
      showBanner: false,
    });
  });

  it("DataFast needs both id and domain", () => {
    expect(
      analyticsEnabled(readAnalyticsConfig({ NEXT_PUBLIC_DATAFAST_WEBSITE_ID: "x" })).datafast,
    ).toBe(false);
    expect(readAnalyticsConfig({ NEXT_PUBLIC_POSTHOG_KEY: "  " }).posthogKey).toBeUndefined();
  });
});

describe("theme", () => {
  it("is dark-first", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("garbage", true)).toBe("dark");
  });

  it("boot script is self-contained", () => {
    expect(themeBootScript).toContain("desyn-theme");
    expect(() => new Function(themeBootScript)).not.toThrow();
  });
});

describe("structured data", () => {
  it("describes the app with offers from plans.json", () => {
    const ld = softwareApplicationJsonLd();
    expect(ld["@type"]).toBe("SoftwareApplication");
    const offers = ld.offers as { price: string; priceCurrency: string }[];
    expect(offers.map((o) => o.price)).toEqual(["0", "8", "80"]);
    expect(offers.every((o) => o.priceCurrency === "USD")).toBe(true);
  });

  it("escapes markup", () => {
    const s = serializeJsonLd(faqJsonLd([{ q: "</script><script>alert(1)</script>", a: "a & b" }]));
    expect(s).not.toContain("</script>");
    expect(s).not.toContain("&");
    expect(JSON.parse(s).mainEntity[0].name).toBe("</script><script>alert(1)</script>");
  });

  it("builds absolute urls", () => {
    expect(absoluteUrl("/pricing")).toBe("https://desyn.app/pricing");
    expect(absoluteUrl("pricing")).toBe("https://desyn.app/pricing");
    expect(absoluteUrl("https://x.y/z")).toBe("https://x.y/z");
  });
});
