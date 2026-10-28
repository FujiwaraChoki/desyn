import { describe, expect, test } from "vitest";
import { SvgSanitizeError, sanitizeCss, sanitizeSvg } from "../lib/designs_svg";

describe("sanitizeSvg", () => {
  test("keeps drawing content and normalizes namespaces", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12" viewBox="0 0 24 12"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="24" height="12" fill="url(#g)"/><text x="1" y="10">Hi &amp; bye</text></svg>';
    const out = sanitizeSvg(input);
    expect(out.changed).toBe(false);
    expect(out.width).toBe(24);
    expect(out.height).toBe(12);
    expect(out.svg).toContain('fill="url(#g)"');
    expect(out.svg).toContain("Hi &amp; bye");
    expect(out.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  test("removes scripts, event handlers, foreignObject and animation elements", () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil"/></body></foreignObject>
      <rect width="1" height="1" onclick="steal()" ONMOUSEOVER="x()"/>
      <a href="javascript:alert(1)"><circle r="2"/></a>
      <set attributeName="href" to="javascript:alert(1)"/>
      <animate attributeName="x" values="0;1"/>
    </svg>`;
    const out = sanitizeSvg(input);
    expect(out.changed).toBe(true);
    for (const bad of [
      "script",
      "onload",
      "onclick",
      "ONMOUSEOVER",
      "foreignObject",
      "iframe",
      "javascript",
      "<set",
      "<animate",
      "<a",
    ]) {
      expect(out.svg).not.toContain(bad);
    }
    expect(out.svg).toContain("<circle");
    expect(out.svg).toContain("<rect");
  });

  test("drops external references but keeps fragments and embedded rasters", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const input = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <use href="#icon"/><use xlink:href="https://evil.example/sprite.svg#x"/>
      <image href="https://tracker.example/pixel.png" width="1" height="1"/>
      <image xlink:href="${png}" width="1" height="1"/>
      <rect fill="url(https://evil.example/p.svg#f)" style="fill:url(http://x/y);stroke:red" width="1" height="1"/>
      <style>@import url(https://evil.example/a.css); .a{fill:url(#ok);background:url(http://e/x.png)}</style>
    </svg>`;
    const out = sanitizeSvg(input);
    expect(out.svg).toContain('href="#icon"');
    expect(out.svg).toContain(`xlink:href="${png}"`);
    expect(out.svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(out.svg).not.toContain("evil.example");
    expect(out.svg).not.toContain("tracker.example");
    expect(out.svg).not.toContain("http://x/y");
    expect(out.svg).not.toContain("@import");
    expect(out.svg).toContain("url(#ok)");
    expect(out.svg).toContain("stroke:red");
  });

  test("rejects entity declarations and non-SVG input; strips plain doctypes", () => {
    expect(() =>
      sanitizeSvg(
        '<!DOCTYPE svg [<!ENTITY lol "lol">]><svg xmlns="http://www.w3.org/2000/svg">&lol;</svg>',
      ),
    ).toThrow(SvgSanitizeError);
    expect(() => sanitizeSvg("<html><body/></html>")).toThrow(SvgSanitizeError);
    expect(() => sanitizeSvg("<svg><rect></svg>")).toThrow(SvgSanitizeError);
    const out = sanitizeSvg(
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" width="5"><path d="M0 0h1"/></svg>',
    );
    expect(out.svg).not.toContain("DOCTYPE");
    expect(out.width).toBe(5);
    expect(out.height).toBe(10);
  });

  test("CSS escapes cannot smuggle scriptable values", () => {
    const css = sanitizeCss("fill: u\\72l(http://evil/x); behavior: url(x.htc)");
    expect(css.changed).toBe(true);
    expect(css.css).not.toContain("\\");
    expect(css.css).not.toMatch(/behavior\s*:/i);
  });

  test("removing one token cannot assemble another (sanitizer runs to a fixpoint)", () => {
    const attacks = [
      "fill:urjavascript:l(http://evil/x)",
      "fill:u\\0 rl(http://evil/x)",
      "fill:url\\(http://evil/x)",
      "@im\\0 port 'http://evil/a.css';",
      "fill:url(javajavascript:script:alert(1))",
      "background:javajavascript:script:alert(1)",
      "fill:url(http://evil/unclosed",
      "background-image:image-set('http://evil/x.png' 1x)",
      "@font-face{font-family:x;src:url(http://evil/f.woff)}",
    ];
    for (const attack of attacks) {
      const out = sanitizeCss(attack).css;
      expect(out, attack).not.toMatch(/url\(\s*['"]?\s*[^#\s'"]/i);
      expect(out, attack).not.toMatch(/javascript\s*:/i);
      expect(out, attack).not.toMatch(/@import|@font-face|image-set\s*\(|\bsrc\s*\(/i);
    }
    // Clean CSS is left alone.
    expect(sanitizeCss(".a{fill:url(#g);stroke:red}")).toEqual({
      css: ".a{fill:url(#g);stroke:red}",
      changed: false,
    });
  });

  test("style attributes and <style> elements go through the fixpoint sanitizer", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:urjavascript:l(http://evil/s)}</style><rect style="fill:u\\0 rl(http://evil/r)" width="1" height="1"/></svg>`,
    );
    expect(out.changed).toBe(true);
    expect(out.svg).not.toContain("http://evil");
    expect(out.svg).toContain("<rect");
  });
});
