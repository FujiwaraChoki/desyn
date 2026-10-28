import { describe, expect, it } from "vitest";
import { isPublicPath, loginUrl, safeNext } from "./routes";

describe("safeNext", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNext("/design/abc?x=1#h")).toBe("/design/abc?x=1#h");
    expect(safeNext("/settings/billing")).toBe("/settings/billing");
  });
  it("rejects off-site and malformed targets", () => {
    for (const bad of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "\\\\evil.test",
      "javascript:alert(1)",
      "/a\nb",
      "/a\\b",
      "",
      null,
      undefined,
    ]) {
      expect(safeNext(bad, "/")).toBe("/");
    }
  });
});

describe("isPublicPath", () => {
  it("allows auth and share pages without a session", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/share/abc")).toBe(true);
    expect(isPublicPath("/accept/token")).toBe(true);
    expect(isPublicPath("/api/auth/get-session")).toBe(true);
  });
  it("protects the app", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/settings/profile")).toBe(false);
    expect(isPublicPath("/design/x")).toBe(false);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/share")).toBe(false);
  });
});

describe("loginUrl", () => {
  it("encodes the next path", () => {
    // safeNext normalizes to a URL path ("a%20b"), which is then encoded as a query value.
    expect(loginUrl("/design/a b")).toBe("/login?next=%2Fdesign%2Fa%2520b");
    expect(loginUrl("/design/k3?x=1")).toBe("/login?next=%2Fdesign%2Fk3%3Fx%3D1");
    expect(loginUrl("/")).toBe("/login");
    expect(loginUrl("https://evil.test")).toBe("/login");
  });
});
