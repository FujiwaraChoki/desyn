import { describe, expect, test } from "vitest";
import { ID_LENGTH, isId, isNodeId, newId } from "../src";

describe("ids", () => {
  test("newId is 12 chars of [a-z0-9]", () => {
    for (let i = 0; i < 2000; i++) {
      const id = newId();
      expect(id).toHaveLength(ID_LENGTH);
      expect(id).toMatch(/^[a-z0-9]{12}$/);
      expect(isId(id)).toBe(true);
    }
  });

  test("newId does not collide over 50k draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) seen.add(newId());
    expect(seen.size).toBe(50_000);
  });

  test("every alphabet symbol is used roughly uniformly", () => {
    const counts = new Map<string, number>();
    const draws = 6000;
    for (let i = 0; i < draws; i++)
      for (const ch of newId()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(36);
    const expected = (draws * 12) / 36;
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(expected * 0.85);
      expect(n).toBeLessThan(expected * 1.15);
    }
  });

  test("isId / isNodeId", () => {
    expect(isId("abcdef012345")).toBe(true);
    expect(isId("ABCDEF012345")).toBe(false);
    expect(isId("abcdef01234")).toBe(false);
    expect(isId("abcdef0123456")).toBe(false);
    expect(isId("abcdef01234-")).toBe(false);
    expect(isId("root")).toBe(false);
    expect(isId(42)).toBe(false);
    expect(isNodeId("root")).toBe(true);
    expect(isNodeId("abcdef012345")).toBe(true);
    expect(isNodeId("nope")).toBe(false);
  });
});
