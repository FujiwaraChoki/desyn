import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./content/capabilities";
import { FAQ } from "./content/faq";
import { FEATURES, featureBySlug } from "./content/features";
import { LEGAL_DOCS } from "./content/legal";
import { publicRoutes } from "./routes";
import { parseManifest, specForEntry, TEMPLATE_CATEGORIES, TEMPLATE_SPECS } from "./templates";

describe("templates manifest", () => {
  it("accepts the common shapes and skips junk", () => {
    const entries = parseManifest({
      templates: [
        {
          slug: "a",
          title: "Poster A",
          category: ["posters"],
          kind: "poster",
          premium: true,
          thumbnail: "https://cdn.example/a.webp",
        },
        { id: "b", name: "Post B", categories: ["social"], thumbs: { small: "/local/b.webp" } },
        { slug: "a", title: "Duplicate" },
        { title: "No slug" },
        null,
        42,
      ],
    });
    expect(entries).toEqual([
      {
        slug: "a",
        title: "Poster A",
        category: "Posters",
        kind: "poster",
        premium: true,
        thumbnail: "https://cdn.example/a.webp",
      },
      {
        slug: "b",
        title: "Post B",
        category: "Social",
        kind: "design",
        premium: false,
        thumbnail: null,
      },
    ]);
    expect(parseManifest([{ slug: "x", title: "X" }])).toHaveLength(1);
    expect(parseManifest({ items: [{ slug: "y", title: "Y" }] })).toHaveLength(1);
    expect(parseManifest("nonsense")).toEqual([]);
    expect(parseManifest(null)).toEqual([]);
  });

  it("gives entries without thumbnails a deterministic generated preview", () => {
    const [e] = parseManifest([{ slug: "menu-1", title: "Bistro menu card", category: "menus" }]);
    if (!e) throw new Error("expected an entry");
    const a = specForEntry(e);
    const b = specForEntry(e);
    expect(a).toEqual(b);
    expect(a.copy.headline).toBe("Bistro menu card");
    expect(a.slug).toBe("menu-1");
  });

  it("ships a varied set of generated previews", () => {
    expect(new Set(TEMPLATE_SPECS.map((t) => t.slug)).size).toBe(TEMPLATE_SPECS.length);
    expect(TEMPLATE_CATEGORIES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(TEMPLATE_SPECS.map((t) => t.layout)).size).toBe(12);
  });
});

describe("content", () => {
  it("has six capabilities and six feature pages", () => {
    expect(CAPABILITIES).toHaveLength(6);
    expect(FEATURES.map((f) => f.slug)).toEqual([
      "ai",
      "templates",
      "brand",
      "workflows",
      "collaboration",
      "self-hosting",
    ]);
    expect(featureBySlug("brand")?.availability).toMatch(/10 brand kits/);
    expect(featureBySlug("nope")).toBeUndefined();
  });

  it("is honest about Free having no AI", () => {
    expect(FAQ.find((f) => f.q === "Is Desyn really free?")?.a).toMatch(/does not include AI/);
    expect(featureBySlug("ai")?.availability).toMatch(/Not part of the Free plan/);
  });

  it("lists every public route once for the sitemap", () => {
    const paths = publicRoutes().map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of [
      "/",
      "/pricing",
      "/features",
      "/features/ai",
      "/templates",
      "/download",
      "/changelog",
      "/about",
      "/security",
      "/contact",
    ]) {
      expect(paths).toContain(p);
    }
    for (const d of LEGAL_DOCS) expect(paths).toContain(`/legal/${d.slug}`);
  });
});
