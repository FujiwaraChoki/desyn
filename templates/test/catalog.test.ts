import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, type Design, validateDesign } from "@desyn/schema";
import { beforeAll, describe, expect, it } from "vitest";
import type { ManifestEntry } from "../src/cli/generate";
import { NICHES } from "../src/copy/niches";
import { IMAGERY } from "../src/imagery";
import { setImageResolver } from "../src/lib/doc";
import { DESIGNS_DIR, MANIFEST } from "../src/lib/paths";
import { PAIRS, pairFamiliesKnown } from "../src/lib/type";
import { PLAN } from "../src/plan";

beforeAll(() => {
  // Building does not need the photos themselves, only their catalog entries.
  setImageResolver((key) => {
    const spec = IMAGERY.find((s) => s.key === key.replace(/@print$/, ""));
    if (!spec) throw new Error(`unknown image ${key}`);
    return {
      key,
      file: `${key}.jpg`,
      width: 1800,
      height: 1200,
      mime: "image/jpeg",
      alt: spec.alt,
      provenance: { provider: "fal", model: "test", prompt: spec.prompt },
    };
  });
});

describe("plan", () => {
  const plan = PLAN();

  it("ships 300+ templates across every kind the spec lists", () => {
    expect(plan.length).toBeGreaterThanOrEqual(300);
    const kinds = new Set(plan.map((p) => p.kind));
    for (const k of [
      "social-post",
      "story",
      "thumbnail",
      "presentation",
      "poster",
      "flyer",
      "resume",
      "business-card",
      "invitation",
      "menu",
      "certificate",
      "logo",
      "newsletter",
      "infographic",
      "document",
      "banner",
      "ad",
      "book-cover",
      "whiteboard",
    ]) {
      expect(kinds, k).toContain(k);
    }
  });

  it("has unique slugs and ~40% premium", () => {
    expect(new Set(plan.map((p) => p.slug)).size).toBe(plan.length);
    const premium = plan.filter((p) => p.premium).length / plan.length;
    expect(premium).toBeGreaterThan(0.3);
    expect(premium).toBeLessThan(0.5);
  });

  it("is deterministic", () => {
    const again = PLAN();
    expect(again.map((p) => `${p.slug}:${p.palette}:${p.pair}`)).toEqual(
      plan.map((p) => `${p.slug}:${p.palette}:${p.pair}`),
    );
    const sample = plan.filter((_, i) => i % 37 === 0);
    for (const spec of sample) {
      const twin = again.find((p) => p.slug === spec.slug);
      expect(canonicalize(twin?.build().design)).toBe(canonicalize(spec.build().design));
    }
  });

  it("builds a contract-valid design for every template", () => {
    for (const spec of plan) {
      const res = validateDesign(spec.build().design);
      expect(res.errors, spec.slug).toEqual([]);
    }
  });

  it("gives decks at least eight slides with notes", () => {
    for (const spec of plan.filter((p) => p.kind === "presentation")) {
      const d = spec.build().design;
      const pages = (d.nodes.root as unknown as { children: string[] }).children;
      expect(pages.length).toBeGreaterThanOrEqual(8);
      for (const id of pages)
        expect((d.nodes[id] as { notes?: string }).notes, `${spec.slug} ${id}`).toBeTruthy();
    }
  });
});

describe("copy and type", () => {
  it("never ships placeholder copy", () => {
    const text = JSON.stringify(NICHES).toLowerCase();
    for (const bad of ["lorem", "ipsum", "placeholder", "your text here", "todo"])
      expect(text).not.toContain(bad);
  });

  it("only uses fonts from the shared catalog", () => {
    for (const p of PAIRS) expect(pairFamiliesKnown(p), p.id).toBe(true);
  });

  it("references only catalog imagery", () => {
    const keys = new Set(IMAGERY.map((s) => s.key));
    for (const n of NICHES) for (const k of n.images) expect(keys, `${n.id} ${k}`).toContain(k);
  });
});

// The generated library on disk (skipped before the first `pnpm generate`).
describe.skipIf(!existsSync(MANIFEST))("generated library", () => {
  const manifest = existsSync(MANIFEST)
    ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as ManifestEntry[])
    : [];

  it("stores a valid, engine-normalized design for every manifest entry", () => {
    for (const m of manifest) {
      const d = JSON.parse(readFileSync(join(DESIGNS_DIR, `${m.slug}.json`), "utf8")) as Design;
      expect(validateDesign(d).errors, m.slug).toEqual([]);
      expect(d.kind).toBe(m.kind);
    }
  });
});
