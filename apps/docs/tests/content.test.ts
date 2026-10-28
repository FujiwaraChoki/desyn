import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzePage, contentPath } from "../src/lib/content.ts";
import { FLAT_NAV } from "../src/lib/nav.ts";
import { nodeText } from "../src/lib/search-index.ts";

const pages = await Promise.all(FLAT_NAV.map((item) => analyzePage(item.slug)));

describe("content", () => {
  it.each(pages.map((p) => [p.slug || "(home)", p] as const))(
    "%s has a title and a useful description",
    (_, page) => {
      const { title, description } = page.data.frontmatter;
      expect(title.trim().length).toBeGreaterThan(2);
      expect(description.length).toBeGreaterThanOrEqual(40);
      expect(description.length).toBeLessThanOrEqual(260);
    },
  );

  it.each(pages.map((p) => [p.slug || "(home)", p] as const))("%s has real content", (_, page) => {
    const text = nodeText(page.tree);
    expect(text.length).toBeGreaterThan(300);
  });

  it("contains no placeholders or unfinished markers", async () => {
    for (const item of FLAT_NAV) {
      const source = await readFile(contentPath(item.slug), "utf8");
      expect(source, item.slug).not.toMatch(/DRAFT-PLACEHOLDER|\bTODO\b|\bTBD\b|lorem ipsum/i);
    }
  });

  it("gives every heading a unique id", () => {
    for (const page of pages) {
      const ids = page.data.toc.map((t) => t.id);
      expect(new Set(ids).size, page.slug).toBe(ids.length);
      expect(ids, page.slug).not.toContain("main-content");
    }
  });

  it("never prints a secret-looking value", async () => {
    for (const item of FLAT_NAV) {
      const source = await readFile(contentPath(item.slug), "utf8");
      // Real keys: OpenRouter, Anthropic/OpenAI, Stripe live, AWS access keys, Desyn API keys with a body.
      expect(source, item.slug).not.toMatch(
        /sk-or-v1-[a-z0-9]{20,}|sk-[A-Za-z0-9]{32,}|sk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|dsk_[A-Za-z0-9_-]{43}/,
      );
    }
  });
});
