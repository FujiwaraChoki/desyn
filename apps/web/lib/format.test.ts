import { describe, expect, it } from "vitest";
import {
  displayIp,
  formatBytes,
  formatCurrency,
  formatSize,
  relativeTime,
  usageRatio,
} from "./format";

describe("format", () => {
  it("formats relative times", () => {
    const now = Date.UTC(2026, 9, 20, 12);
    expect(relativeTime(now - 10_000, now, "en")).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
    expect(relativeTime(now - 2 * 3600_000, now, "en")).toBe("2 hours ago");
    expect(relativeTime(now - 24 * 3600_000, now, "en")).toBe("yesterday");
    expect(relativeTime(now - 40 * 24 * 3600_000, now, "en")).toBe("last month");
  });
  it("formats bytes", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 250, "en")).toBe("250 MB");
    expect(formatBytes(-1, "en")).toBe("—");
  });
  it("formats money and sizes", () => {
    expect(formatCurrency(8, "usd", "en-US")).toBe("$8");
    expect(formatCurrency(7.5, "usd", "en-US")).toBe("$7.50");
    expect(formatSize(1080, 1350)).toBe("1080 × 1350 px");
  });
  it("computes usage ratios", () => {
    expect(usageRatio(5, 10)).toBe(0.5);
    expect(usageRatio(50, 10)).toBe(1);
    expect(usageRatio(5, null)).toBe(0);
  });
});

describe("displayIp", () => {
  it("hides unspecified addresses and keeps real ones", () => {
    for (const v of [
      null,
      undefined,
      "",
      "0.0.0.0",
      "::",
      "0000:0000:0000:0000:0000:0000:0000:0000",
    ]) {
      expect(displayIp(v)).toBeNull();
    }
    expect(displayIp("203.0.113.7")).toBe("203.0.113.7");
    expect(displayIp("2001:db8::1")).toBe("2001:db8::1");
    expect(displayIp("::1")).toBe("::1");
  });
});
