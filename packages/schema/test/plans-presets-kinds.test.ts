import { describe, expect, test } from "vitest";
import plansJson from "../../../config/plans.json" with { type: "json" };
import * as S from "../src";

describe("plans", () => {
  test("loads every plan with expanded features", () => {
    expect(S.PLAN_IDS.sort()).toEqual(["free", "pro", "selfhost"]);
    expect(S.FEATURE_KEYS.length).toBe(Object.keys(plansJson.plans.free.features).length);
    for (const id of S.PLAN_IDS) {
      expect(Object.keys(S.getPlan(id).features).sort()).toEqual([...S.FEATURE_KEYS].sort());
      expect(Object.keys(S.getPlan(id).limits).sort()).toEqual([...S.LIMIT_KEYS].sort());
    }
    expect(S.FEATURE_KEYS.every((k) => S.can("pro", k) && S.can("selfhost", k))).toBe(true);
  });

  test("can / limit / withinLimit / creditCost", () => {
    expect(S.can("free", "editor.core")).toBe(true);
    expect(S.can("free", "ai.agent")).toBe(false);
    expect(S.can("pro", "ai.agent")).toBe(true);
    expect(S.limit("free", "designs")).toBe(20);
    expect(S.limit("pro", "designs")).toBeNull();
    expect(S.limit("pro", "creditsPerMonth")).toBe(600);
    expect(S.withinLimit("free", "designs", 20)).toBe(true);
    expect(S.withinLimit("free", "designs", 21)).toBe(false);
    expect(S.withinLimit("selfhost", "designs", 1e9)).toBe(true);
    expect(S.creditCost("ai.generateDesign")).toBe(5);
    expect(S.creditCost("ai.videoClip")).toBe(40);
    expect(S.PLANS.plans.pro.priceMonthly).toBe(8);
    expect(S.PLANS.plans.pro.priceYearly).toBe(80);
    expect(S.PLANS.fairUse.byokBypassesCredits).toBe(true);
  });

  test("planForEdition", () => {
    const now = 1_000;
    expect(S.planForEdition("selfhost", null, now)).toBe("selfhost");
    expect(S.planForEdition("selfhost", { plan: "free", status: "canceled" }, now)).toBe(
      "selfhost",
    );
    expect(S.planForEdition("hosted", null, now)).toBe("free");
    expect(S.planForEdition("hosted", { plan: "pro", status: "active" }, now)).toBe("pro");
    expect(S.planForEdition("hosted", { plan: "pro", status: "trialing" }, now)).toBe("pro");
    expect(S.planForEdition("hosted", { plan: "pro", status: "past_due" }, now)).toBe("pro");
    expect(S.planForEdition("hosted", { plan: "pro", status: "unpaid" }, now)).toBe("free");
    expect(
      S.planForEdition("hosted", { plan: "pro", status: "canceled", currentPeriodEnd: 2_000 }, now),
    ).toBe("pro");
    expect(
      S.planForEdition("hosted", { plan: "pro", status: "canceled", currentPeriodEnd: 500 }, now),
    ).toBe("free");
    expect(S.planForEdition("hosted", { plan: "selfhost", status: "active" }, now)).toBe("free");
  });

  test("guards", () => {
    expect(S.isPlanId("pro")).toBe(true);
    expect(S.isPlanId("enterprise")).toBe(false);
    expect(S.isFeatureKey("ai.agent")).toBe(true);
    expect(S.isFeatureKey("ai.nope")).toBe(false);
    expect(S.parseEdition("hosted")).toBe("hosted");
    expect(S.parseEdition(undefined)).toBe("selfhost");
  });
});

describe("presets", () => {
  test("at least 90 presets with unique ids and sane sizes", () => {
    expect(S.PAGE_PRESETS.length).toBeGreaterThanOrEqual(90);
    const ids = new Set(S.PAGE_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(S.PAGE_PRESETS.length);
    for (const p of S.PAGE_PRESETS) {
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
      expect(S.DESIGN_KINDS).toContain(p.kind);
      if (p.physical) {
        expect(p.width).toBeCloseTo(S.toPx(p.physical.width, p.physical.unit), 1);
        expect(p.height).toBeCloseTo(S.toPx(p.physical.height, p.physical.unit), 1);
        expect(p.dpi).toBe(300);
        expect(p.bleed).toBeGreaterThan(0);
      }
      if (p.safeArea) {
        expect(p.safeArea.left + p.safeArea.right).toBeLessThan(p.width);
        expect(p.safeArea.top + p.safeArea.bottom).toBeLessThan(p.height);
      }
    }
  });

  test.each([
    ["instagram-post", 1080, 1080],
    ["instagram-portrait", 1080, 1350],
    ["instagram-story", 1080, 1920],
    ["facebook-cover", 1640, 624],
    ["x-header", 1500, 500],
    ["linkedin-banner", 1584, 396],
    ["youtube-thumbnail", 1280, 720],
    ["youtube-banner", 2560, 1440],
    ["pinterest-pin", 1000, 1500],
    ["ad-medium-rectangle", 300, 250],
    ["ad-leaderboard", 728, 90],
    ["ad-wide-skyscraper", 160, 600],
    ["ad-half-page", 300, 600],
    ["ad-mobile-banner", 320, 50],
    ["ad-billboard", 970, 250],
    ["kindle-cover", 1600, 2560],
    ["website-hero", 1440, 900],
    ["whiteboard", 4000, 3000],
    ["logo", 500, 500],
    ["presentation-16-9", 1920, 1080],
    ["presentation-4-3", 1024, 768],
    ["business-card-us", 336, 192],
    ["flyer-letter", 816, 1056],
    ["invitation-5x7", 480, 672],
    ["book-cover-6x9", 576, 864],
  ])("%s is %ix%i px", (id, w, h) => {
    const p = S.getPreset(id);
    expect(p?.width).toBe(w);
    expect(p?.height).toBe(h);
  });

  test("print sizes in mm", () => {
    expect(S.getPreset("poster-a4")?.width).toBeCloseTo((210 / 25.4) * 96, 1);
    expect(S.getPreset("poster-a3")?.physical).toEqual({ width: 297, height: 420, unit: "mm" });
    expect(S.getPreset("business-card-eu")?.physical).toEqual({
      width: 85,
      height: 55,
      unit: "mm",
    });
    expect(S.getPreset("business-card-jp")?.physical).toEqual({
      width: 91,
      height: 55,
      unit: "mm",
    });
    expect(S.getPreset("resume-a4")?.unit).toBe("mm");
    expect(S.getPreset("resume-letter")?.unit).toBe("in");
  });

  test("helpers", () => {
    expect(S.presetsForKind("ad").length).toBeGreaterThanOrEqual(14);
    expect(S.presetsForPlatform("instagram").length).toBeGreaterThanOrEqual(5);
    expect(S.findPresetsBySize(1080, 1920).map((p) => p.id)).toContain("instagram-story");
    expect(S.findPresetsBySize(1920, 1080, true).map((p) => p.id)).toContain("instagram-story");
    expect(S.toPx(1, "in")).toBe(96);
    expect(S.toPx(72, "pt")).toBe(96);
    expect(S.fromPx(96, "mm")).toBeCloseTo(25.4, 6);
    expect(S.toPx(5, "px")).toBe(5);
  });
});

describe("kinds and roles", () => {
  test("every kind has info and a default preset of a sensible size", () => {
    for (const k of S.DESIGN_KINDS) {
      const info = S.DESIGN_KIND_INFO[k];
      expect(info.kind).toBe(k);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.icon).toMatch(/^[a-z0-9-]+$/);
      expect(S.getPreset(info.defaultPreset)).toBeDefined();
    }
    expect(S.DESIGN_KIND_LIST).toHaveLength(S.DESIGN_KINDS.length);
    expect(S.isDesignKind("poster")).toBe(true);
    expect(S.isDesignKind("toString")).toBe(false);
  });

  test("known roles match the contract list", () => {
    expect(S.KNOWN_ROLES).toHaveLength(47);
    expect(S.KNOWN_ROLES).toContain("headline");
    expect(S.KNOWN_ROLES).toContain("form-field");
    expect(S.isKnownRole("cta")).toBe(true);
    expect(S.isKnownRole("whatever")).toBe(false);
  });
});
