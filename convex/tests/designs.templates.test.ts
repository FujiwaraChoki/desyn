import { createDesign, createSvg, createText, type Design, validateDesign } from "@desyn/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { firstPageId, loadAll, workspaceOf } from "./designs.helpers";
import { createUser, errorData, setupTest } from "./harness.helpers";

beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
afterEach(() => vi.unstubAllEnvs());

function templateDesign(headline: string): Design {
  const design = createDesign("menu", undefined, { name: "Bakery menu" });
  const pageId = (design.nodes.root as { children: string[] }).children[0] as string;
  const text = createText({
    parent: pageId,
    text: headline,
    role: "headline",
    meta: { slot: "headline" },
  });
  design.nodes[text.id] = text;
  (design.nodes[pageId] as { children: string[] }).children.push(text.id);
  return design;
}

async function publish(
  t: ReturnType<typeof setupTest>,
  slug: string,
  opts: { premium?: boolean; headline?: string; category?: string } = {},
) {
  return await t.mutation(internal.templates.admin.upsert, {
    slug,
    title: slug.replace(/-/g, " "),
    description: "Warm and minimal",
    kind: "menu",
    category: opts.category ?? "food",
    categories: ["restaurant"],
    tags: ["bakery", "pastry"],
    premium: opts.premium ?? false,
    collections: ["cafe-favorites"],
    design: JSON.stringify(templateDesign(opts.headline ?? "Fresh croissants daily")),
    thumbnails: [],
  });
}

describe("templates", () => {
  test("upsert, search, list by collection/category, get", async () => {
    const t = setupTest();
    const basic = await publish(t, "bakery-menu");
    await publish(t, "coffee-menu", { headline: "Single origin espresso", category: "drinks" });
    expect(basic.created).toBe(true);
    expect((await publish(t, "bakery-menu")).created).toBe(false);

    const found = await t.query(api.templates.templates.search, {
      query: "croissants",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(found.page.map((x) => x.slug)).toEqual(["bakery-menu"]);
    const byCategory = await t.query(api.templates.templates.list, {
      category: "drinks",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(byCategory.page.map((x) => x.slug)).toEqual(["coffee-menu"]);
    const collection = await t.query(api.templates.templates.list, {
      collection: "cafe-favorites",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(collection.page.map((x) => x.slug)).toEqual(["bakery-menu"]);
    expect(collection.isDone).toBe(false);
    const collections = await t.query(api.templates.templates.collections, {});
    expect(collections[0]).toMatchObject({
      slug: "cafe-favorites",
      count: 2,
      title: "Cafe Favorites",
    });
    expect(await t.query(api.templates.templates.categories, {})).toEqual([
      { category: "drinks", count: 1 },
      { category: "food", count: 1 },
    ]);
    const got = await t.query(api.templates.templates.get, { slug: "bakery-menu" });
    expect(got).toMatchObject({
      kind: "menu",
      premium: false,
      canUse: true,
      categories: ["food", "restaurant"],
    });
    const { design } = await t.query(api.templates.templates.getDesign, {
      templateId: basic.templateId,
    });
    expect(validateDesign(JSON.parse(design)).ok).toBe(true);
  });

  test("inline SVG markup in template designs is sanitized on upsert", async () => {
    const t = setupTest();
    const design = templateDesign("Logo");
    const pageId = (design.nodes.root as { children: string[] }).children[0] as string;
    const svg = createSvg({
      parent: pageId,
      markup:
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect width="1" height="1"/></svg>',
    });
    design.nodes[svg.id] = svg;
    (design.nodes[pageId] as { children: string[] }).children.push(svg.id);
    const { templateId } = await t.mutation(internal.templates.admin.upsert, {
      slug: "svg-logo",
      title: "Svg logo",
      description: "",
      kind: "menu",
      category: "food",
      categories: [],
      tags: [],
      premium: false,
      design: JSON.stringify(design),
      thumbnails: [],
    });
    const stored = JSON.parse(
      (await t.query(api.templates.templates.getDesign, { templateId })).design,
    ) as Design;
    const markup = (stored.nodes[svg.id] as { markup: string }).markup;
    expect(markup).toContain("<rect");
    expect(markup).not.toContain("script");
    expect(markup).not.toContain("onload");

    design.nodes[svg.id] = { ...svg, markup: "<html><body/></html>" };
    const err = await errorData(
      t.mutation(internal.templates.admin.upsert, {
        slug: "svg-broken",
        title: "Broken",
        description: "",
        kind: "menu",
        category: "food",
        categories: [],
        tags: [],
        premium: false,
        design: JSON.stringify(design),
        thumbnails: [],
      }),
    );
    expect(err).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  test("instantiate copies with fresh ids; premium needs the plan; favorites", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const basic = await publish(t, "bakery-menu");
    const premium = await publish(t, "luxury-menu", { premium: true });
    const tpl = JSON.parse(
      (await t.query(api.templates.templates.getDesign, { templateId: basic.templateId })).design,
    ) as Design;

    const { designId, key } = await user.as.mutation(api.templates.templates.instantiate, {
      templateId: basic.templateId,
      workspaceId,
    });
    const loaded = await loadAll(user.as, designId);
    expect(loaded.design.id).toBe(key);
    expect(key).not.toBe(tpl.id);
    expect(validateDesign(loaded.design).ok).toBe(true);
    const tplIds = new Set(Object.keys(tpl.nodes).filter((id) => id !== "root"));
    expect(Object.keys(loaded.design.nodes).some((id) => tplIds.has(id))).toBe(false);
    expect(loaded.design.meta.templateId).toBe(basic.templateId);
    const pageId = firstPageId(loaded.design);
    expect((loaded.design.nodes[pageId] as { children: string[] }).children).toHaveLength(1);
    const summary = await user.as.query(api.designs.designs.get, { designId });
    expect(summary.templateId).toBe(basic.templateId);
    expect(
      (await t.query(api.templates.templates.get, { templateId: basic.templateId })).popularity,
    ).toBe(1);

    await user.as.mutation(api.templates.templates.favorite, {
      templateId: basic.templateId,
      favorite: true,
    });
    const favs = await user.as.query(api.templates.templates.favorites, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(favs.page.map((f) => f.slug)).toEqual(["bakery-menu"]);
    expect(
      (await user.as.query(api.templates.templates.get, { templateId: basic.templateId })).favorite,
    ).toBe(true);

    vi.stubEnv("DESYN_EDITION", "hosted");
    expect(
      (await user.as.query(api.templates.templates.get, { templateId: premium.templateId })).canUse,
    ).toBe(false);
    expect(
      await errorData(
        user.as.mutation(api.designs.designs.create, {
          workspaceId,
          templateId: premium.templateId,
        }),
      ),
    ).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "templates.premium" });
    // The premium design JSON is not handed out either (it could be imported instead).
    expect(
      await errorData(
        user.as.query(api.templates.templates.getDesign, { templateId: premium.templateId }),
      ),
    ).toMatchObject({ code: "FEATURE_UNAVAILABLE", feature: "templates.premium" });
    expect(
      (
        await errorData(
          t.query(api.templates.templates.getDesign, { templateId: premium.templateId }),
        )
      ).code,
    ).toBe("UNAUTHENTICATED");
    expect(
      (await t.query(api.templates.templates.getDesign, { templateId: basic.templateId })).design,
    ).toContain('"schema":1');
  });

  test("publish requires an admin or the pipeline token and rejects invalid designs", async () => {
    vi.stubEnv("TEMPLATES_PIPELINE_SECRET", "pipeline-token-123");
    const t = setupTest();
    const admin = await createUser(t); // the first self-host user is the admin
    const user = await createUser(t);
    const bundle = {
      slug: "promo-flyer",
      title: "Promo flyer",
      description: "Bold",
      kind: "flyer",
      category: "marketing",
      categories: [],
      tags: ["sale"],
      premium: false,
      design: JSON.stringify(createDesign("flyer")),
    };
    expect((await errorData(user.as.action(api.templates.admin.publish, bundle))).code).toBe(
      "FORBIDDEN",
    );
    expect(
      (await errorData(t.action(api.templates.admin.publish, { ...bundle, token: "wrong" }))).code,
    ).toBe("UNAUTHENTICATED");
    const ok = await t.action(api.templates.admin.publish, {
      ...bundle,
      token: "pipeline-token-123",
    });
    expect(ok.created).toBe(true);
    expect(
      (
        await errorData(
          t.action(api.templates.admin.publish, {
            ...bundle,
            token: "pipeline-token-123",
            design: '{"schema":1}',
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      (await admin.as.action(api.templates.admin.publish, { ...bundle, premium: true })).created,
    ).toBe(false);
    expect((await t.query(api.templates.templates.get, { slug: "promo-flyer" })).premium).toBe(
      true,
    );
    expect(
      (await t.mutation(internal.templates.admin.remove, { slug: "promo-flyer" })).removed,
    ).toBe(true);
  });
});

describe("brand kits", () => {
  test("CRUD with validation, default handling and plan gating", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const workspaceId = await workspaceOf(user);
    const kitId = await user.as.mutation(api.brand.brandKits.create, {
      workspaceId,
      name: "Sunrise",
      colors: [
        { name: "Sun", value: "#FFB02E", role: "primary" },
        { name: "Ink", value: "#0a0a0a", role: "text" },
      ],
      fonts: { heading: { family: "Instrument Serif", weight: 400, style: "normal" } },
      voice: {
        tone: "Warm",
        description: "Friendly and concise",
        keywords: ["bright"],
        avoid: ["jargon"],
      },
      rules: ["Logo needs 24px clear space"],
    });
    const kit = await user.as.query(api.brand.brandKits.get, { brandKitId: kitId });
    expect(kit).toMatchObject({
      name: "Sunrise",
      isDefault: true,
      rules: ["Logo needs 24px clear space"],
    });
    expect(kit.colors.map((c) => c.value)).toEqual(["#ffb02e", "#0a0a0a"]);
    expect(kit.fonts.heading?.family).toBe("Instrument Serif");
    expect(
      (
        await errorData(
          user.as.mutation(api.brand.brandKits.update, {
            brandKitId: kitId,
            colors: [{ name: "Bad", value: "red" }],
          }),
        )
      ).code,
    ).toBe("INVALID_ARGUMENT");
    await user.as.mutation(api.brand.brandKits.update, {
      brandKitId: kitId,
      name: "Sunrise 2",
      voice: null,
    });
    const second = await user.as.mutation(api.brand.brandKits.duplicate, { brandKitId: kitId });
    await user.as.mutation(api.brand.brandKits.setDefault, { brandKitId: second });
    let kits = await user.as.query(api.brand.brandKits.list, { workspaceId });
    expect(kits.map((k) => [k.name, k.isDefault])).toEqual([
      ["Sunrise 2 (copy)", true],
      ["Sunrise 2", false],
    ]);
    expect(kits[1]?.voice).toBeNull();
    await user.as.mutation(api.brand.brandKits.delete, { brandKitId: second });
    kits = await user.as.query(api.brand.brandKits.list, { workspaceId });
    expect(kits.map((k) => [k.name, k.isDefault])).toEqual([["Sunrise 2", true]]);
    expect((await user.as.query(api.billing.usage.summary, {})).meters.brandKits.used).toBe(1);

    vi.stubEnv("DESYN_EDITION", "hosted");
    expect(
      await errorData(user.as.mutation(api.brand.brandKits.create, { workspaceId, name: "X" })),
    ).toMatchObject({
      code: "FEATURE_UNAVAILABLE",
      feature: "brandKit",
    });
  });
});
