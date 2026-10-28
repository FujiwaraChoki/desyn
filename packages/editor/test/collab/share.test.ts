import { describe, expect, test } from "vitest";
import { buildEmbedCode, embedUrl, escapeHtml, parseEmails } from "../../src/collab/share/embed.ts";
import { cleanVersionName, groupVersions } from "../../src/collab/versions/model.ts";

describe("share helpers", () => {
  test("embed URLs and snippets are escaped and keep parameters", () => {
    expect(embedUrl("https://app.desyn.app/share/abc?x=1")).toBe(
      "https://app.desyn.app/share/abc?x=1&embed=1",
    );
    expect(embedUrl("/share/abc")).toBe("/share/abc?embed=1");
    expect(escapeHtml(`"<a>'&`)).toBe("&quot;&lt;a&gt;&#39;&amp;");
    const fixed = buildEmbedCode({
      url: "https://app.desyn.app/share/abc",
      title: 'Poster "summer" <b>',
      size: { mode: "fixed", width: 800.4, height: 450 },
    });
    expect(fixed).toContain('src="https://app.desyn.app/share/abc?embed=1"');
    expect(fixed).toContain('title="Poster &quot;summer&quot; &lt;b&gt;"');
    expect(fixed).toContain('width="800" height="450"');
    const responsive = buildEmbedCode({
      url: "https://app.desyn.app/share/abc",
      title: "",
      size: { mode: "responsive", aspect: 4 / 5 },
    });
    expect(responsive).toContain("padding-top:125%");
    expect(responsive).toContain(">Desyn design</a>");
  });

  test("invite lists accept commas, spaces, angle brackets; report invalid entries", () => {
    expect(parseEmails("ada@x.io, Bo@Y.org; <cy@z.dev>\nada@x.io nope")).toEqual({
      valid: ["ada@x.io", "bo@y.org", "cy@z.dev"],
      invalid: ["nope"],
    });
  });

  test("versions group by day, newest first, filtered by kind", () => {
    const now = new Date(2026, 9, 21, 15).getTime();
    const v = (id: string, createdAt: number, auto: boolean) => ({
      id,
      name: id,
      seq: 1,
      status: "ready" as const,
      auto,
      pageCount: 1,
      createdBy: "u",
      createdByName: null,
      createdAt,
      error: null,
    });
    const list = [
      v("a", now - 60_000, true),
      v("b", now - 2 * 60_000, false),
      v("c", now - 86_400_000, true),
      v("d", now - 40 * 86_400_000, false),
    ];
    const all = groupVersions(list, "all", now);
    expect(all.map((g) => [g.label, g.versions.map((x) => x.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [all[2]?.label, ["d"]],
    ]);
    expect(groupVersions(list, "named", now).flatMap((g) => g.versions.map((x) => x.id))).toEqual([
      "b",
      "d",
    ]);
    expect(groupVersions(list, "auto", now).flatMap((g) => g.versions.map((x) => x.id))).toEqual([
      "a",
      "c",
    ]);
    expect(cleanVersionName("  Final   final ")).toBe("Final final");
    expect(cleanVersionName("   ")).toBeNull();
    expect(cleanVersionName("x".repeat(101))).toBeNull();
  });
});
