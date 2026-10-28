import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentPath } from "../src/lib/content.ts";
import { FLAT_NAV, findNavItem, hrefForSlug, isNested, NAV, neighbours } from "../src/lib/nav.ts";
import { contentDir } from "../src/lib/paths.ts";

function listMdx(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listMdx(full) : name.endsWith(".mdx") ? [full] : [];
  });
}

describe("navigation", () => {
  it("has a content file for every entry", () => {
    for (const item of FLAT_NAV) expect(existsSync(contentPath(item.slug)), item.slug).toBe(true);
  });

  it("lists every content file exactly once", () => {
    const files = listMdx(contentDir()).map((f) =>
      path.relative(contentDir(), f).replace(/\.mdx$/, ""),
    );
    const slugs = FLAT_NAV.map((i) => (i.slug === "" ? "index" : i.slug));
    expect([...files].sort()).toEqual([...slugs].sort());
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("builds hrefs and neighbours in reading order", () => {
    expect(hrefForSlug("")).toBe("/");
    expect(hrefForSlug("editor/text")).toBe("/editor/text");
    expect(neighbours("")).toEqual({ prev: undefined, next: findNavItem("quickstart") });
    const last = FLAT_NAV[FLAT_NAV.length - 1];
    expect(last && neighbours(last.slug).next).toBeUndefined();
  });

  it("nests sub-pages under their parent but not under the section root", () => {
    const start = NAV.find((s) => s.id === "start");
    const editor = NAV.find((s) => s.id === "editor");
    const developers = NAV.find((s) => s.id === "developers");
    if (!start || !editor || !developers) throw new Error("missing section");
    expect(isNested("concepts/layers", start)).toBe(true);
    expect(isNested("concepts", start)).toBe(false);
    expect(isNested("editor/text", editor)).toBe(false);
    expect(isNested("developers/api/designs", developers)).toBe(true);
    expect(isNested("developers/api", developers)).toBe(false);
  });

  it("covers every area the docs must document", () => {
    const required = [
      "quickstart",
      "concepts",
      "editor/keyboard-shortcuts",
      "editor/export",
      "editor/import",
      "ai/agent",
      "ai/local-models",
      "ai/providers-and-byok",
      "self-hosting/docker-compose",
      "self-hosting/configuration",
      "self-hosting/backups",
      "self-hosting/reverse-proxy",
      "self-hosting/admin-console",
      "developers/document-model",
      "developers/api",
      "developers/mcp",
      "developers/sdk",
      "developers/license",
      "changelog",
      "legal",
    ];
    for (const slug of required) expect(findNavItem(slug), slug).toBeDefined();
  });
});
