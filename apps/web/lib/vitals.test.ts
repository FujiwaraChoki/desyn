import { describe, expect, it } from "vitest";
import { axiomEnabled, axiomRequest, parseVital, routePattern } from "./vitals";

describe("vitals", () => {
  it("validates samples", () => {
    expect(parseVital({ name: "LCP", value: 1200, id: "v1", route: "/", rating: "good" })).toEqual({
      name: "LCP",
      value: 1200,
      id: "v1",
      route: "/",
      rating: "good",
    });
    expect(parseVital({ name: "XSS", value: 1, id: "v", route: "/" })).toBeNull();
    expect(parseVital({ name: "LCP", value: Number.NaN, id: "v", route: "/" })).toBeNull();
    expect(parseVital({ name: "LCP", value: 1, id: "v", route: "https://x" })).toBeNull();
    expect(parseVital(null)).toBeNull();
  });
  it("strips ids and tokens from routes", () => {
    expect(routePattern("/design/abc123")).toBe("/design/[id]");
    expect(routePattern("/share/tok/x")).toBe("/share/[token]/x");
    expect(routePattern("/settings/billing")).toBe("/settings/billing");
    expect(routePattern("/")).toBe("/");
  });
  it("builds the ingest request only when configured", () => {
    expect(axiomEnabled({})).toBe(false);
    expect(axiomRequest({}, [])).toBeNull();
    const req = axiomRequest(
      { AXIOM_TOKEN: "t", AXIOM_DATASET: "desyn", AXIOM_ORG_ID: "o" },
      [{ name: "CLS", value: 0.01, id: "a", route: "/" }],
      0,
    );
    expect(req?.url).toBe("https://api.axiom.co/v1/datasets/desyn/ingest");
    const headers = (req ? req.init.headers : {}) as Record<string, string>;
    expect(headers["x-axiom-org-id"]).toBe("o");
    expect(String(req?.init.body)).toContain('"type":"web-vital"');
  });
});
