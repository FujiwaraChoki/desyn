import { describe, expect, it } from "vitest";
import { inferKind } from "./infer-kind";

describe("inferKind", () => {
  it("maps common requests to formats", () => {
    expect(inferKind("Pitch deck for a climate startup, 8 slides")).toBe("presentation");
    expect(inferKind("Minimal wedding invitation in sage")).toBe("invitation");
    expect(inferKind("YouTube thumbnail: I tried film photography")).toBe("thumbnail");
    expect(inferKind("A warm autumn poster for a jazz night")).toBe("poster");
    expect(inferKind("Instagram story for our sale")).toBe("story");
    expect(inferKind("Launch post for a coffee subscription")).toBe("social-post");
    expect(inferKind("logo for a bakery")).toBe("logo");
  });
  it("falls back when nothing matches", () => {
    expect(inferKind("something lovely")).toBe("social-post");
    expect(inferKind("something lovely", "custom")).toBe("custom");
  });
});
