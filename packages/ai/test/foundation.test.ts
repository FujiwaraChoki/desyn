import { describe, expect, it } from "vitest";
import {
  byokAad,
  decryptKey,
  encryptKey,
  isEncryptedKey,
  keyHint,
  redactKey,
  redactObject,
  redactSecrets,
} from "../src/byok";
import {
  CREDIT_ACTION,
  CreditMeter,
  creditsFor,
  estimateAgentRun,
  estimateCredits,
  settleCredits,
} from "../src/credits";
import { decodePng, encodePng } from "../src/design/raster";
import { AbortError, fetchJson, mapLimit, sleep, TtlCache } from "../src/util/async";
import {
  base64ToBytes,
  bytesToBase64,
  imageSize,
  parseDataUri,
  sniffMime,
  toDataUri,
} from "../src/util/bytes";
import { fakeFetch, json, solidPng } from "./helpers";

describe("bytes", () => {
  it("round-trips base64 for every length", () => {
    for (let n = 0; n < 20; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
    expect(bytesToBase64(new TextEncoder().encode("Man"))).toBe("TWFu");
    expect(() => base64ToBytes("@@@")).toThrow();
  });

  it("parses data URIs (base64 and percent-encoded)", () => {
    const uri = toDataUri(new Uint8Array([1, 2, 3]), "application/octet-stream");
    expect(parseDataUri(uri)).toEqual({
      mime: "application/octet-stream",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(new TextDecoder().decode(parseDataUri("data:text/plain,hello%20world")?.bytes)).toBe(
      "hello world",
    );
    expect(parseDataUri("https://x")).toBeNull();
  });

  it("sniffs media types and reads image sizes", () => {
    const png = solidPng(7, 3);
    expect(sniffMime(png)).toBe("image/png");
    expect(imageSize(png)).toEqual({ width: 7, height: 3 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]);
    expect(imageSize(gif)).toEqual({ width: 10, height: 20 });
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"></svg>',
    );
    expect(sniffMime(svg)).toBe("image/svg+xml");
    expect(imageSize(svg)).toEqual({ width: 48, height: 24 });
    // Minimal JPEG: SOI, APP0 skeleton, SOF0 with 16x8.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 8, 0, 16, 3, 1, 0x22, 0,
    ]);
    expect(sniffMime(jpeg)).toBe("image/jpeg");
    expect(imageSize(jpeg)).toEqual({ width: 16, height: 8 });
  });

  it("encodes and decodes PNG pixels", async () => {
    const data = new Uint8Array(3 * 2 * 4);
    data.set([255, 0, 0, 255], 0);
    data.set([0, 255, 0, 128], 4 * 4);
    const decoded = await decodePng(encodePng(3, 2, data));
    expect(decoded.width).toBe(3);
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(decoded.data.slice(16, 20))).toEqual([0, 255, 0, 128]);
  });
});

describe("byok", () => {
  const secret = "a-test-secret-that-is-long-enough";

  it("encrypts and decrypts with AAD binding", async () => {
    const blob = await encryptKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123", secret, {
      aad: byokAad("user1", "openrouter"),
    });
    expect(isEncryptedKey(blob)).toBe(true);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(await decryptKey(blob, secret, { aad: byokAad("user1", "openrouter") })).toBe(
      "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123",
    );
    await expect(
      decryptKey(blob, secret, { aad: byokAad("user2", "openrouter") }),
    ).rejects.toThrow();
    await expect(
      decryptKey(blob, "another-secret-that-is-long", { aad: byokAad("user1", "openrouter") }),
    ).rejects.toThrow();
    await expect(decryptKey("v2.x.y", secret)).rejects.toThrow("unsupported");
  });

  it("uses a fresh IV per encryption and rejects short secrets", async () => {
    const a = await encryptKey("same", secret);
    const b = await encryptKey("same", secret);
    expect(a).not.toBe(b);
    await expect(encryptKey("x", "short")).rejects.toThrow();
  });

  it("redacts keys in text and objects", () => {
    expect(keyHint("sk-abcdefghijklmnop1234")).toBe("…1234");
    expect(redactKey("sk-or-v1-0123456789abcdefghij")).toBe("sk-or-v1-[redacted]ghij");
    const text =
      "key sk-ant-ABCDEFGHIJKLMNOPQRSTUV and Bearer abcdefghijklmnopqrstuvwx and fal 12345678-1234-1234-1234-123456789abc:0123456789abcdef0123456789abcdef";
    const out = redactSecrets(text);
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
    expect(
      redactObject({
        apiKey: "secret-value",
        nested: { Authorization: "Bearer x" },
        note: "plain",
        bytes: new Uint8Array(3),
      }),
    ).toEqual({
      apiKey: "[redacted]",
      nested: { Authorization: "[redacted]" },
      note: "plain",
      bytes: "[3 bytes]",
    });
  });
});

describe("credits", () => {
  it("maps actions to plans.json costs", () => {
    expect(creditsFor("image")).toBe(3);
    expect(creditsFor("agent.turn", 4)).toBe(4);
    expect(creditsFor("video")).toBe(40);
    expect(CREDIT_ACTION.trace).toBe("ai.svg");
  });

  it("estimates with BYOK and local calls free", () => {
    const e = estimateCredits([
      { action: "image", count: 2 },
      { action: "agent.turn", count: 10, billing: "byok" },
      { action: "copy", billing: "local" },
    ]);
    expect(e.total).toBe(6);
    expect(e.lines.map((l) => l.free)).toEqual([false, true, true]);
    expect(
      estimateAgentRun({
        maxSteps: 20,
        generateDesign: true,
        expectedAssets: [{ action: "image" }],
      }).total,
    ).toBe(20 + 3 + 5);
  });

  it("settles against reservations and meters with a cap", () => {
    expect(settleCredits(10, 7)).toEqual({ charge: 7, release: 3, overage: 0 });
    expect(settleCredits(5, 8)).toEqual({ charge: 8, release: 0, overage: 3 });
    const meter = new CreditMeter(5);
    meter.charge("image", "platform");
    expect(meter.used).toBe(3);
    expect(meter.wouldExceed("image", "platform")).toBe(true);
    expect(meter.wouldExceed("image", "byok")).toBe(false);
    meter.charge("agent.turn", "platform", { count: 2 });
    expect(meter.remaining).toBe(0);
    expect(meter.breakdown()).toEqual({ "ai.image": 3, "agent.turn": 2 });
  });
});

describe("async utils", () => {
  it("caches with TTL and de-duplicates in-flight loads", async () => {
    let now = 0;
    const cache = new TtlCache<number>(100, () => now);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    now = 150;
    expect(cache.peek("k")).toBeUndefined();
    expect(cache.stale("k")).toBe(1);
    expect(await cache.get("k", load)).toBe(2);
  });

  it("retries 429 responses honouring Retry-After", async () => {
    let n = 0;
    const { fetch } = fakeFetch({
      "/x": () =>
        ++n < 2
          ? new Response("", { status: 429, headers: { "retry-after": "0" } })
          : json({ ok: true }),
    });
    expect(await fetchJson("https://h/x?key=secret", { fetch })).toEqual({ ok: true });
    const failing = fakeFetch({ "/y": () => new Response("", { status: 401 }) });
    await expect(fetchJson("https://h/y?key=secret", { fetch: failing.fetch })).rejects.toThrow(
      /401/,
    );
    await expect(fetchJson("https://h/y?key=secret", { fetch: failing.fetch })).rejects.not.toThrow(
      /secret/,
    );
  });

  it("maps with a concurrency limit and aborts sleeps", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (v) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
      return v * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
    const ctrl = new AbortController();
    const p = sleep(10_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });
});
