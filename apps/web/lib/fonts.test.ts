import { describe, expect, it } from "vitest";
import { coversBasicLatin, googleFontsCssUrl, parseFontFaces } from "./fonts";

describe("google fonts", () => {
  it("builds css2 urls", () => {
    expect(googleFontsCssUrl("Playfair Display", [700, 400, 400])).toBe(
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap",
    );
  });
  it("parses faces and ignores foreign urls", () => {
    const css = `/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/a.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Evil';
  src: url(https://evil.test/x.woff2) format('woff2');
}`;
    expect(parseFontFaces(css)).toEqual([
      {
        family: "Inter",
        weight: "400",
        style: "normal",
        url: "https://fonts.gstatic.com/s/inter/v13/a.woff2",
        unicodeRange: "U+0000-00FF",
      },
    ]);
  });
});

describe("coversBasicLatin", () => {
  it("keeps latin and range-less faces, skips other subsets", () => {
    expect(coversBasicLatin(undefined)).toBe(true);
    expect(coversBasicLatin("U+0000-00FF, U+0131, U+0152-0153")).toBe(true);
    expect(coversBasicLatin("U+0100-02BA, U+02BD-02C5")).toBe(false);
    expect(coversBasicLatin("U+0301, U+0400-045F, U+0490-0491")).toBe(false);
    expect(coversBasicLatin("U+0370-0377, U+037A-037F")).toBe(false);
  });
});
