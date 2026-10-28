import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { createUser, setupTest } from "./harness.helpers";

async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { data?: { code?: string } }).data?.code;
  }
}

const unsplashPhoto = (i: number) => ({
  id: `u${i}`,
  width: 4000,
  height: 3000,
  color: "#aabbcc",
  alt_description: `photo ${i}`,
  urls: {
    raw: `https://images.unsplash.com/p${i}?ixid=1`,
    regular: "",
    small: `https://images.unsplash.com/p${i}-small`,
  },
  links: {
    html: `https://unsplash.com/photos/u${i}`,
    download_location: `https://api.unsplash.com/photos/u${i}/download`,
  },
  user: { name: `Author ${i}`, links: { html: `https://unsplash.com/@a${i}` } },
});

describe("stock/photos", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("needs a signed-in user and configured keys", async () => {
    const t = setupTest();
    expect(await errorCode(t.action(api.stock.photos.search, { query: "sun" }))).toBe(
      "UNAUTHENTICATED",
    );
    const a = await createUser(t);
    vi.stubEnv("UNSPLASH_ACCESS_KEY", "");
    vi.stubEnv("PEXELS_API_KEY", "");
    expect(await errorCode(a.as.action(api.stock.photos.search, { query: "sun" }))).toBe(
      "NOT_CONFIGURED",
    );
    expect(await errorCode(a.as.action(api.stock.photos.search, { query: "  " }))).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("searches Unsplash with attribution, pages and tracks downloads", async () => {
    const t = setupTest();
    const a = await createUser(t);
    vi.stubEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    vi.stubEnv("PEXELS_API_KEY", "");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Client-ID test-unsplash-key");
      if (url.includes("/download")) return new Response("{}", { status: 200 });
      const perPage = Number(new URL(url).searchParams.get("per_page"));
      return new Response(
        JSON.stringify({ results: Array.from({ length: perPage }, (_, i) => unsplashPhoto(i)) }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const first = await a.as.action(api.stock.photos.search, { query: "sunset", count: 10 });
    expect(first.photos).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(first.photos[0]).toMatchObject({
      id: "unsplash:u0",
      provider: "unsplash",
      author: "Author 0",
      license: "Unsplash License",
      downloadLocation: "https://api.unsplash.com/photos/u0/download",
    });
    const second = await a.as.action(api.stock.photos.search, {
      query: "sunset",
      count: 10,
      page: 2,
    });
    expect(second.photos[0].id).toBe("unsplash:u10");
    const tracked = await a.as.action(api.stock.photos.track, {
      id: "unsplash:u0",
      downloadLocation: "https://api.unsplash.com/photos/u0/download",
    });
    expect(tracked.tracked).toBe(true);
    expect(
      await errorCode(
        a.as.action(api.stock.photos.track, {
          id: "unsplash:u0",
          downloadLocation: "https://evil.example/x",
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    // The server key only reaches the photo's own download endpoint.
    for (const downloadLocation of [
      "https://api.unsplash.com/photos/u1/download",
      "https://api.unsplash.com/me",
      "https://api.unsplash.com:8443/photos/u0/download",
      "http://api.unsplash.com/photos/u0/download",
    ]) {
      expect(
        await errorCode(
          a.as.action(api.stock.photos.track, { id: "unsplash:u0", downloadLocation }),
        ),
      ).toBe("INVALID_ARGUMENT");
    }
    const withQuery = await a.as.action(api.stock.photos.track, {
      id: "unsplash:u0",
      downloadLocation: "https://api.unsplash.com/photos/u0/download?ixid=abc",
    });
    expect(withQuery.tracked).toBe(true);
    expect(calls.filter((c) => c.includes("/download"))).toHaveLength(2);
  });
});
