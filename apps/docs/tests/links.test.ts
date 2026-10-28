import { describe, expect, it } from "vitest";
import { checkContentLinks, findLinkProblems, formatProblems } from "../src/lib/link-check.ts";

describe("link checker", () => {
  it("finds no broken links in the docs", async () => {
    const report = await checkContentLinks();
    expect(report.links).toBeGreaterThan(200);
    expect(formatProblems(report.problems)).toBe("");
  });

  it("reports missing pages, missing anchors and unsafe links", () => {
    const report = findLinkProblems([
      {
        slug: "a",
        data: {
          anchors: ["intro"],
          links: [
            { url: "#intro", line: 1 },
            { url: "#nope", line: 2 },
            { url: "/b#target", line: 3 },
            { url: "/b#missing", line: 4 },
            { url: "/c", line: 5 },
            { url: "relative/page", line: 6 },
            { url: "http://insecure.example.org", line: 7 },
            { url: "mailto:hello@desyn.app", line: 8 },
            { url: "/search-index.json", line: 9 },
          ],
        },
      },
      { slug: "b", data: { anchors: ["target"], links: [] } },
    ]);
    expect(report.problems.map((p) => p.line)).toEqual([2, 4, 5, 6, 7]);
  });
});
