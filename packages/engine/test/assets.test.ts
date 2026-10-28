import { describe, expect, it } from "vitest";
import { AssetFetchError, AssetLoader } from "../src/assets";

function fakeFetch(statuses: number[]) {
  const seen: string[] = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
    return status === 200 ? new Response(new Uint8Array([1, 2, 3])) : new Response("x", { status });
  }) as typeof fetch;
  return { f, seen };
}

describe("asset loader", () => {
  it("retries transient failures", async () => {
    const { f, seen } = fakeFetch([503, 200]);
    const bytes = await new AssetLoader({ fetch: f, retries: 2 }).load("https://x/a");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(2);
  });

  it("does not retry client errors", async () => {
    const { f, seen } = fakeFetch([404]);
    await expect(new AssetLoader({ fetch: f }).load("https://x/a")).rejects.toBeInstanceOf(
      AssetFetchError,
    );
    expect(seen).toHaveLength(1);
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const f = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response(new Uint8Array([0]));
    }) as typeof fetch;
    const loader = new AssetLoader({ fetch: f, concurrency: 2 });
    await Promise.all(Array.from({ length: 7 }, (_, i) => loader.load(`https://x/${i}`)));
    expect(peak).toBe(2);
  });

  it("enforces the size limit", async () => {
    const f = (async () => new Response(new Uint8Array(10))) as typeof fetch;
    await expect(new AssetLoader({ fetch: f, maxBytes: 4 }).load("https://x/big")).rejects.toThrow(
      /limit/,
    );
  });
});
