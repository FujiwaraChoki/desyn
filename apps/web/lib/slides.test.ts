import { describe, expect, it } from "vitest";
import { slideIndexFromParam } from "./slides";

describe("slideIndexFromParam", () => {
  it("maps 1-based slide numbers to indexes", () => {
    expect(slideIndexFromParam("1")).toBe(0);
    expect(slideIndexFromParam("7")).toBe(6);
  });

  it("falls back to the first slide for missing or malformed values", () => {
    for (const v of [null, "", "0", "-3", "abc", "2.5", "Infinity", "1e400"]) {
      expect(slideIndexFromParam(v)).toBe(0);
    }
  });
});
