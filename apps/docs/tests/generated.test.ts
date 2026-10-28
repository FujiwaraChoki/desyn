import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ENDPOINTS, API_GROUPS, API_SCOPES } from "../src/data/api.ts";
import { ENV_GROUPS, ENV_VARS, envAnchor } from "../src/data/env.ts";
import { SHORTCUT_GROUPS } from "../src/data/shortcuts.ts";
import { FEATURE_LABELS, GENERATORS, generate } from "../src/lib/generated.ts";
import { parseMarkdownFragment, parseMdxFragment } from "../src/lib/markdown.ts";
import { findNavItem } from "../src/lib/nav.ts";
import { repoPath } from "../src/lib/paths.ts";
import { featureKeys, loadPlans } from "../src/lib/plans.ts";

/** Variable names listed in SPEC section 9, with `A/B` pairs expanded (`GOOGLE_CLIENT_ID/SECRET`). */
function specEnvNames(): string[] {
  const spec = readFileSync(repoPath("docs/SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("## 9."), spec.indexOf("## 10."));
  const names = new Set<string>();
  for (const m of section.matchAll(/`([A-Z][A-Z0-9_]*(?:\/[A-Z0-9_]+)?\*?)`/g)) {
    const raw = m[1] ?? "";
    if (raw.includes("/")) {
      const [head = "", tail = ""] = raw.split("/");
      names.add(head);
      names.add(`${head.slice(0, head.lastIndexOf("_") + 1)}${tail}`);
    } else {
      names.add(raw);
    }
  }
  return [...names];
}

describe("environment variable reference", () => {
  it("documents every variable named in SPEC section 9", () => {
    const documented = new Set(ENV_VARS.map((v) => v.name));
    const missing = specEnvNames().filter(
      (n) => !documented.has(n) && !["ses", "smtp", "log", "hosted", "selfhost"].includes(n),
    );
    expect(missing).toEqual([]);
  });

  it("has unique names, known groups and complete entries", () => {
    const names = ENV_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    const groups = new Set(ENV_GROUPS.map((g) => g.id));
    for (const v of ENV_VARS) {
      expect(groups.has(v.group), v.name).toBe(true);
      expect(v.description.length, v.name).toBeGreaterThan(20);
      if (v.required === "conditional") expect(v.requiredWhen, v.name).toBeTruthy();
    }
    expect(new Set(ENV_VARS.map((v) => envAnchor(v.name))).size).toBe(names.length);
  });

  it("marks credentials as secret", () => {
    for (const v of ENV_VARS) {
      if (
        /_KEY$|SECRET|TOKEN|PASSWORD|SMTP_URL/.test(v.name) &&
        !v.name.startsWith("NEXT_PUBLIC_")
      ) {
        expect(v.secret, v.name).toBe(true);
      }
    }
  });
});

describe("shortcuts", () => {
  it("has no conflicting combos within a group unless explained", () => {
    for (const group of SHORTCUT_GROUPS) {
      const seen = new Map<string, string>();
      for (const s of group.shortcuts) {
        for (const combo of s.keys) {
          const prior = seen.get(combo);
          if (prior !== undefined)
            expect(
              s.note,
              `${group.id}: ${combo} used by "${prior}" and "${s.action}"`,
            ).toBeTruthy();
          seen.set(combo, s.action);
        }
      }
    }
  });
});

describe("API reference data", () => {
  it("has unique ids and titles per page, valid scopes and pages that exist", () => {
    const ids = API_ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const scopes = new Set<string>([...API_SCOPES.map((s) => s.scope), "any"]);
    for (const group of API_GROUPS)
      expect(findNavItem(`developers/api/${group.page}`), group.page).toBeDefined();
    const titlesByPage = new Map<string, string[]>();
    for (const e of API_ENDPOINTS) {
      expect(scopes.has(e.scope), e.id).toBe(true);
      expect(e.path.startsWith("/"), e.id).toBe(true);
      const page = API_GROUPS.find((g) => g.id === e.group)?.page ?? "";
      titlesByPage.set(page, [...(titlesByPage.get(page) ?? []), e.title.toLowerCase()]);
      for (const p of e.params.filter((x) => x.in === "path"))
        expect(e.path, e.id).toContain(`{${p.name}}`);
    }
    for (const [page, titles] of titlesByPage)
      expect(new Set(titles).size, page).toBe(titles.length);
  });

  const validatorsPath = repoPath("convex/lib/validators.ts");
  it.skipIf(!existsSync(validatorsPath))(
    "matches the API key scopes implemented by the backend",
    () => {
      const validators = readFileSync(validatorsPath, "utf8");
      const block = validators.slice(validators.indexOf("ALL_API_KEY_SCOPES"));
      const implemented = [...block.slice(0, block.indexOf("];")).matchAll(/"([a-z:]+)"/g)].map(
        (m) => m[1],
      );
      expect(API_SCOPES.map((s) => s.scope).sort()).toEqual([...implemented].sort());
    },
  );
});

describe("plans", () => {
  it("has a label for every feature flag in config/plans.json", () => {
    for (const key of featureKeys(loadPlans())) expect(FEATURE_LABELS[key], key).toBeDefined();
  });

  it("matches the numbers the prose relies on", () => {
    // These values are written in sentences across the docs (quickstart, credits, limits).
    // If plans.json changes, update the prose and these expectations together.
    const p = loadPlans();
    expect(p.plans.pro.priceMonthly).toBe(8);
    expect(p.plans.pro.limits.creditsPerMonth).toBe(600);
    expect(p.plans.free.limits.pagesPerDesign).toBe(10);
    expect(p.plans.pro.limits.pagesPerDesign).toBe(200);
    expect(p.plans.free.limits.uploadMbPerFile).toBe(15);
    expect(p.plans.pro.limits.uploadMbPerFile).toBe(200);
    expect(p.plans.selfhost.limits.uploadMbPerFile).toBe(1024);
    expect(p.plans.free.limits.exportsPerMonth).toBe(300);
    expect(p.plans.pro.limits.exportsPerMonth).toBe(5000);
    expect(p.plans.pro.limits.versionHistoryDays).toBe(90);
    expect(p.plans.pro.limits.brandKits).toBe(10);
    expect(p.plans.pro.limits.workspaces).toBe(5);
    expect(p.plans.pro.limits.collaboratorsPerDesign).toBe(25);
    expect(p.creditCosts["agent.turn"]).toBe(1);
    expect(p.creditCosts["ai.generateDesign"]).toBe(5);
    expect(p.creditCosts["ai.image"]).toBe(3);
    expect(p.creditCosts["workflow.campaignDesign"]).toBe(5);
    expect(p.creditCosts["workflow.resizeVariant"]).toBe(1);
    expect(p.creditCosts["workflow.localizeVariant"]).toBe(1);
    expect(p.fairUse.throttleDelayMs).toEqual([1500, 6000]);
    expect(p.fairUse.maxConcurrentRuns).toBe(3);
  });
});

describe("generators", () => {
  const cases: [string, Record<string, string>][] = [
    ["env-vars", {}],
    ["env-vars", { group: "storage" }],
    ["shortcuts", {}],
    ["plan-limits", {}],
    ["plan-features", {}],
    ["credit-costs", {}],
    ["fair-use", {}],
    ["api-endpoints", { page: "designs" }],
    ["api-index", {}],
    ["api-scopes", {}],
    ["model-section", { section: "4" }],
    ["model-section", { section: "5", prose: "true" }],
    ["model-section", { section: "3", subsection: "Role" }],
    ["model-types", { names: "Design,Fill,Op" }],
  ];

  it("covers every generator", () => {
    expect(new Set(cases.map(([n]) => n))).toEqual(new Set(Object.keys(GENERATORS)));
  });

  it.each(cases)("%s %j produces content that parses", (name, props) => {
    const block = generate(name, props);
    expect(block.text.length).toBeGreaterThan(20);
    const nodes =
      block.format === "md" ? parseMarkdownFragment(block.text) : parseMdxFragment(block.text);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("renders the unlimited and not-included cases readably", () => {
    const text = generate("plan-limits", {}).text;
    expect(text).toContain("Unlimited");
    expect(text).toContain("$8/month or $80/year");
    expect(text).toContain("Not included");
  });

  it("keeps the curl examples copy-pasteable", () => {
    const text = generate("api-endpoints", { page: "designs" }).text;
    expect(text).toContain('curl "https://api.desyn.app/api/v1/designs" \\');
    expect(text).toContain('-H "Authorization: Bearer $DESYN_API_KEY"');
    expect(text).toContain("/designs/$DESIGN_ID/transactions");
  });

  it("rejects unknown generators and props", () => {
    expect(() => generate("nope", {})).toThrow(/Unknown/);
    expect(() => generate("model-types", { names: "NotAType" })).toThrow(/NotAType/);
    expect(() => generate("model-section", {})).toThrow(/section/);
  });
});
