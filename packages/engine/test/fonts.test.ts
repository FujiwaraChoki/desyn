import { describe, expect, it } from "vitest";
import {
  cssWeight,
  designFontNeeds,
  FontLoader,
  parseFontCss,
  parseUnicodeRange,
} from "../src/fonts";
import { fixture } from "./helpers";

const ROBOTO_CSS = `/* cyrillic */
@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 700;
  font-stretch: 100%;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/roboto/cyrillic.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
/* latin-ext */
@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/roboto/latin-ext.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+1E00-1E9F;
}
/* latin */
@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/roboto/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F;
}
`;

function slicedCss(n: number): string {
  let css = "";
  for (let i = 0; i < n; i++) {
    const lo = 0x4e00 + i * 0x100;
    css += `/* [${i}] */\n@font-face {\n  font-family: 'Noto Sans JP';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/jp/${i}.woff2) format('woff2');\n  unicode-range: U+${lo.toString(16)}-${(lo + 0xff).toString(16)};\n}\n`;
  }
  css += `/* latin */\n@font-face {\n  font-family: 'Noto Sans JP';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/jp/latin.woff2) format('woff2');\n  unicode-range: U+0000-00FF;\n}\n`;
  return css;
}

function fakeFetch(routes: Record<string, string | number>) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key === undefined ? 404 : routes[key];
    if (typeof r === "number") return new Response("err", { status: r });
    if (url.endsWith(".woff2") || url.endsWith(".ttf"))
      return new Response(new TextEncoder().encode(r));
    return new Response(r, { headers: { "content-type": "text/css" } });
  }) as typeof fetch;
  return { f, seen };
}

describe("font CSS parsing", () => {
  it("parses Google Fonts CSS2 answers", () => {
    const faces = parseFontCss(ROBOTO_CSS);
    expect(faces).toHaveLength(3);
    expect(faces[2]).toMatchObject({
      family: "Roboto",
      style: "normal",
      weight: [700, 700],
      subset: "latin",
    });
    expect(faces[0]?.ranges).toContainEqual([0x400, 0x45f]);
  });

  it("parses unicode ranges with wildcards", () => {
    expect(parseUnicodeRange("U+4??, U+0025-00FF, u+20AC")).toEqual([
      [0x400, 0x4ff],
      [0x25, 0xff],
      [0x20ac, 0x20ac],
    ]);
  });

  it("rounds weights for the CSS API", () => {
    expect(cssWeight(650)).toBe(700);
    expect(cssWeight(1000)).toBe(900);
    expect(cssWeight(Number.NaN)).toBe(400);
  });
});

describe("FontLoader", () => {
  it("serves bundled families from the package (one load per style)", async () => {
    const { f, seen } = fakeFetch({ "Inter-VF.ttf": "inter-bytes" });
    const loader = new FontLoader({ fonts: "https://app.test/fonts/", fetch: f });
    const a = await loader.load({ family: "inter", weight: 400, italic: false });
    const b = await loader.load({ family: "Inter", weight: 700, italic: false });
    expect(a[0]).toMatchObject({
      family: "Inter",
      source: "bundled",
      url: "https://app.test/fonts/Inter-VF.ttf",
    });
    expect(b).toBe(a);
    expect(seen).toHaveLength(1);
  });

  it("loads every subset of a Google family, Latin first", async () => {
    const { f, seen } = fakeFetch({
      "css2?family=Roboto:ital,wght@0,700": ROBOTO_CSS,
      "roboto/": "font-bytes",
    });
    const loader = new FontLoader({ fonts: "https://app.test/fonts/", fetch: f });
    const files = await loader.load({ family: "Roboto", weight: 680, italic: false });
    expect(files.map((x) => x.url.split("/").pop())).toEqual([
      "latin.woff2",
      "cyrillic.woff2",
      "latin-ext.woff2",
    ]);
    expect(files.every((x) => x.family === "Roboto" && x.source === "google")).toBe(true);
    expect(seen[0]).toContain("family=Roboto:ital,wght@0,700");
  });

  it("falls back to coarser CSS queries when a style does not exist", async () => {
    const { f, seen } = fakeFetch({
      "css2?family=Lobster:ital,wght@1,400": 400,
      "css2?family=Lobster:ital@1": 400,
      "css2?family=Lobster:wght@400": ROBOTO_CSS.replace(/Roboto/g, "Lobster"),
      "roboto/": "bytes",
    });
    const loader = new FontLoader({ fonts: "https://app.test/fonts/", fetch: f });
    const files = await loader.load({ family: "Lobster", weight: 400, italic: true });
    expect(files).toHaveLength(3);
    expect(seen.filter((u) => u.includes("css2"))).toHaveLength(3);
  });

  it("fetches only the slices of large families that cover the text, more as text arrives", async () => {
    const { f, seen } = fakeFetch({ "css2?family=Noto+Sans+JP": slicedCss(20), "/jp/": "bytes" });
    const loader = new FontLoader({ fonts: "https://app.test/fonts/", fetch: f });
    await loader.noteText("丁 hello");
    const files = await loader.load({ family: "Noto Sans JP", weight: 400, italic: false });
    expect(files.map((x) => x.url.split("/").pop())).toEqual(["0.woff2"]);
    const more = await loader.noteText("伅倁");
    expect(more.map((x) => x.url.split("/").pop()).sort()).toEqual(["1.woff2", "2.woff2"]);
    expect(await loader.noteText("丂")).toEqual([]);
    expect(seen.filter((u) => u.endsWith(".woff2"))).toHaveLength(3);
  });

  it("uses bundled monochrome emoji when color emoji are unavailable", async () => {
    const { f } = fakeFetch({ "NotoEmoji-VF.ttf": "emoji", "css2?": 500 });
    const loader = new FontLoader({ fonts: "https://app.test/fonts/", fetch: f });
    const files = await loader.load({ family: "Noto Color Emoji", weight: 400, italic: false });
    expect(files[0]).toMatchObject({ family: "Noto Emoji", source: "bundled" });
  });

  it("never asks Google for families that design assets provide, or when disabled", async () => {
    const { f, seen } = fakeFetch({});
    const loader = new FontLoader({
      fonts: "https://app.test/fonts/",
      fetch: f,
      assetFamilies: ["Brand Sans"],
    });
    await expect(loader.load({ family: "Brand Sans", weight: 400, italic: false })).rejects.toThrow(
      /asset/,
    );
    const off = new FontLoader({
      fonts: "https://app.test/fonts/",
      fetch: f,
      googleFonts: false,
    });
    await expect(off.load({ family: "Roboto", weight: 400, italic: false })).rejects.toThrow(
      /offline/,
    );
    expect(seen).toEqual([]);
  });
});

describe("designFontNeeds", () => {
  it("collects families, weights, styles and text from a design", () => {
    const needs = designFontNeeds(fixture("text"));
    const families = new Set(needs.fonts.map((f) => f.family));
    expect(families.has("Instrument Serif")).toBe(true);
    expect(needs.fonts.some((f) => f.italic)).toBe(true);
    expect(needs.text.length).toBeGreaterThan(20);
  });
});
