import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { CATALOG_TTL_MS } from "../ai/catalog";
import { dueForFetch, MIN_REFRESH_MS } from "../ai/models";
import { createUser, setupTest } from "./harness.helpers";

// Model catalogs: a forced refresh or a provider outage never turns into a stream of catalog downloads
// (any signed-in user can call ai.models.list with refresh: true).

beforeEach(() => {
  vi.stubEnv("DESYN_EDITION", "selfhost");
  vi.stubEnv("MAIL_TRANSPORT", "log");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("model catalog refresh", () => {
  test("dueForFetch spaces attempts and honours the TTL", () => {
    const now = 1_000_000_000;
    const good = { count: 10, fetchedAt: now - 60_000, checkedAt: now - 60_000 };
    expect(dueForFetch(undefined, now, false)).toBe(true);
    expect(dueForFetch(good, now, false)).toBe(false);
    expect(dueForFetch(good, now, true)).toBe(false); // refreshed a minute ago
    const older = {
      ...good,
      fetchedAt: now - MIN_REFRESH_MS - 1,
      checkedAt: now - MIN_REFRESH_MS - 1,
    };
    expect(dueForFetch(older, now, true)).toBe(true);
    expect(dueForFetch(older, now, false)).toBe(false);
    const expired = { ...good, fetchedAt: now - CATALOG_TTL_MS - 1, checkedAt: now - 60_000 };
    expect(dueForFetch(expired, now, false)).toBe(false); // a failed attempt a minute ago
    expect(dueForFetch({ ...expired, checkedAt: expired.fetchedAt }, now, false)).toBe(true);
    const failed = {
      count: 0,
      fetchedAt: now - MIN_REFRESH_MS - 1,
      checkedAt: now - MIN_REFRESH_MS - 1,
    };
    expect(dueForFetch(failed, now, false)).toBe(true);
  });

  test("forced refreshes and failing providers are fetched at most once per window", async () => {
    const t = setupTest();
    const user = await createUser(t);
    const hits = { openrouter: 0, fal: 0 };
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("openrouter.ai/api/v1/models")) {
        hits.openrouter++;
        return Response.json({
          data: [
            {
              id: "anthropic/claude-sonnet-5.5",
              name: "Claude Sonnet 5.5",
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            },
          ],
        });
      }
      if (url.includes("openrouter.ai/api/v1/embeddings")) return Response.json({ data: [] });
      if (url.includes("fal.ai")) {
        hits.fal++;
        return new Response("upstream down", { status: 503 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const first = await user.as.action(api.ai.models.list, { task: "agent", refresh: true });
    expect(first.tasks.agent?.[0]?.id).toBe("openrouter:anthropic/claude-sonnet-5.5");
    expect(first.errors.map((e) => e.source)).toEqual(["fal"]);
    const afterFirst = { ...hits };
    expect(afterFirst.openrouter).toBeGreaterThan(0);
    expect(afterFirst.fal).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      await user.as.action(api.ai.models.list, { task: "agent", refresh: true });
    }
    expect(hits).toEqual(afterFirst);
    const rows = await t.run(async (ctx) => await ctx.db.query("aiModelCatalog").collect());
    expect(rows.find((r) => r.source === "fal")).toMatchObject({ count: 0 });
    expect(rows.find((r) => r.source === "fal")?.error).toBeTruthy();
  });
});
