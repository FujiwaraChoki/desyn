import { describe, expect, it } from "vitest";
import {
  DocsSearch,
  expandIdentifiers,
  highlight,
  snippet,
  tokenizeQuery,
} from "../src/lib/search-engine.ts";
import { buildSearchIndex } from "../src/lib/search-index.ts";

const index = await buildSearchIndex();
const engine = new DocsSearch(index.records);

function top(query: string): string | undefined {
  return engine.search(query, 5)[0]?.record.href;
}

describe("search index", () => {
  it("indexes every page with sections and stable ids", () => {
    expect(index.version).toBe(1);
    expect(index.records.length).toBeGreaterThan(300);
    for (const [i, r] of index.records.entries()) expect(r.id).toBe(i);
    expect(new Set(index.records.map((r) => r.href)).size).toBe(index.records.length);
    expect(index.records.find((r) => r.href === "/")?.page).toBe("design at the speed of light.");
  });

  it("includes generated content and component attributes", () => {
    const config = index.records.filter((r) => r.href.startsWith("/self-hosting/configuration"));
    expect(config.some((r) => r.text.includes("S3_ENDPOINT"))).toBe(true);
    const api = index.records.find(
      (r) => r.href === "/developers/api/designs#commit-a-transaction",
    );
    expect(api?.text).toContain("/designs/{designId}/transactions");
  });
});

describe("search ranking", () => {
  it.each([
    ["S3_ENDPOINT", "/self-hosting/configuration"],
    ["keyboard shortcuts", "/editor/keyboard-shortcuts"],
    ["ollama", "/ai/local-models"],
    ["crop marks", "/editor/export"],
    ["inpaint", "/ai/asset-tools"],
    ["commit a transaction", "/developers/api/designs#commit-a-transaction"],
    ["backup", "/self-hosting/backups"],
    ["semantic roles", "/concepts/roles"],
    ["mcp claude", "/developers/mcp"],
    ["ollama origins", "/ai/local-models"],
    ["brand kit", "/concepts/brand-kits"],
    ["AUTH_IP_HEADERS", "/self-hosting/configuration"],
    ["admin key", "/self-hosting/convex#instance-secret-and-admin-key"],
    ["mailpit", "/self-hosting/email#testing-with-mailpit"],
    ["minio", "/self-hosting/storage"],
  ])("%s → %s", (query, expected) => {
    expect(top(query)?.startsWith(expected), `top hit was ${top(query)}`).toBe(true);
  });

  it("matches prefixes while typing", () => {
    expect(top("shortcu")?.startsWith("/editor/keyboard-shortcuts")).toBe(true);
  });

  it("returns nothing for empty or junk queries", () => {
    expect(engine.search("   ")).toEqual([]);
    expect(engine.search("zzqxjv")).toEqual([]);
  });
});

describe("snippets", () => {
  it("tokenizes queries, keeping identifiers intact", () => {
    expect(tokenizeQuery("  S3_ENDPOINT, Docker-Compose ")).toEqual([
      "s3_endpoint",
      "docker-compose",
    ]);
  });

  it("splits snake_case identifiers for indexing", () => {
    expect(expandIdentifiers("set OLLAMA_ORIGINS first")).toBe(
      "set OLLAMA_ORIGINS first OLLAMA ORIGINS",
    );
    expect(expandIdentifiers("plain text")).toBe("plain text");
  });

  it("highlights matches case-insensitively", () => {
    expect(highlight("Use Ollama locally", ["ollama"])).toEqual([
      { text: "Use ", match: false },
      { text: "Ollama", match: true },
      { text: " locally", match: false },
    ]);
  });

  it("windows long text around the first match", () => {
    const text = `${"word ".repeat(60)}needle ${"tail ".repeat(60)}`;
    const segs = snippet(text, ["needle"]);
    const joined = segs.map((s) => s.text).join("");
    expect(joined.startsWith("…")).toBe(true);
    expect(joined.endsWith("…")).toBe(true);
    expect(segs.some((s) => s.match && s.text === "needle")).toBe(true);
  });
});
