import { describe, expect, test } from "vitest";
import { isSafeLink, parseLink } from "../src";

describe("parseLink", () => {
  test("page links", () => {
    expect(parseLink("page:abcdef123456")).toEqual({ kind: "page", pageId: "abcdef123456" });
    expect(parseLink("page:root")).toBeNull();
    expect(parseLink("page:ABCDEF123456")).toBeNull();
    expect(parseLink("page:")).toBeNull();
  });

  test("web, mail and phone URLs are normalized", () => {
    expect(parseLink("https://desyn.app/pricing")).toEqual({
      kind: "url",
      href: "https://desyn.app/pricing",
    });
    expect(parseLink("HTTP://Example.COM")).toEqual({ kind: "url", href: "http://example.com/" });
    expect(parseLink("mailto:hi@desyn.app")?.kind).toBe("url");
    expect(parseLink("tel:+4930123456")?.kind).toBe("url");
  });

  test("script-capable and unknown schemes are rejected, including browser-tolerated obfuscation", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "\u0000javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "blob:https://desyn.app/x",
      "/relative/path",
      "#anchor",
      "",
      "not a url",
    ]) {
      expect(parseLink(bad), JSON.stringify(bad)).toBeNull();
      expect(isSafeLink(bad)).toBe(false);
    }
    expect(parseLink(42)).toBeNull();
    expect(parseLink(null)).toBeNull();
  });
});
