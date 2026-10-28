import { describe, expect, it } from "vitest";
import { retryDelayMs } from "./backoff";

describe("retryDelayMs", () => {
  const mid = () => 0.5;
  it("doubles from 5 s and caps at 60 s", () => {
    expect([0, 1, 2, 3, 4, 9].map((a) => retryDelayMs(a, mid))).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });
  it("adds bounded jitter and never exceeds the cap", () => {
    expect(retryDelayMs(0, () => 0)).toBe(4_000);
    expect(retryDelayMs(0, () => 1)).toBe(6_000);
    expect(retryDelayMs(8, () => 1)).toBe(60_000);
  });
  it("treats bad attempts as the first", () => {
    expect(retryDelayMs(-3, mid)).toBe(5_000);
    expect(retryDelayMs(Number.NaN, mid)).toBe(5_000);
  });
});
