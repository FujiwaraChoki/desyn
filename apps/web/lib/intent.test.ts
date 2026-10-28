import { describe, expect, it } from "vitest";
import { intentFromParams, parseIntent } from "./intent";

describe("signup intent", () => {
  it("accepts pro and template intents", () => {
    expect(intentFromParams({ plan: "pro", interval: "year" }, 1)).toEqual({
      plan: "pro",
      interval: "year",
      at: 1,
    });
    expect(intentFromParams({ template: "summer-sale-post" }, 1)).toEqual({
      template: "summer-sale-post",
      at: 1,
    });
  });
  it("ignores unknown values", () => {
    expect(intentFromParams({ plan: "enterprise" })).toBeNull();
    expect(intentFromParams({ template: "../../x" })).toBeNull();
  });
  it("expires stored intents after a week", () => {
    const raw = JSON.stringify({ plan: "pro", at: 0 });
    expect(parseIntent(raw, 1000)?.plan).toBe("pro");
    expect(parseIntent(raw, 8 * 24 * 3600 * 1000)).toBeNull();
    expect(parseIntent("nope")).toBeNull();
  });
});
