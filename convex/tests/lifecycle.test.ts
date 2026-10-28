import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import { createUser, errorData, setupTest } from "./harness.helpers";

describe("account deletion", () => {
  beforeEach(() => vi.stubEnv("DESYN_EDITION", "selfhost"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("purges personal data, hands team workspaces to the next member, and deletes empty ones", async () => {
    vi.useFakeTimers();
    const t = setupTest();
    const owner = await createUser(t);
    const mate = await createUser(t);
    const shared = await owner.as.mutation(api.accounts.workspaces.create, { name: "Shared" });
    const solo = await owner.as.mutation(api.accounts.workspaces.create, { name: "Solo" });
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        workspaceId: shared,
        userId: mate.userId,
        role: "editor",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const [personal] = await owner.as.query(api.accounts.workspaces.list, {});
    await owner.as.mutation(api.accounts.apiKeys.create, {
      workspaceId: personal?.id ?? shared,
      name: "k",
      scopes: ["designs:read"],
    });
    await owner.as.mutation(api.accounts.folders.create, { workspaceId: solo, name: "F" });
    await t.mutation(internal.billing.credits.reserve, {
      userId: owner.userId,
      kind: "ai.copy",
      refId: "r1",
    });

    const authUser = await t.query(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: owner.userId }],
    });
    await t.mutation(internal.auth.onDelete, { model: "user", doc: authUser });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const state = await t.run(async (ctx) => ({
      profiles: await ctx.db.query("profiles").collect(),
      workspaces: await ctx.db.query("workspaces").collect(),
      memberships: await ctx.db.query("memberships").collect(),
      apiKeys: await ctx.db.query("apiKeys").collect(),
      folders: await ctx.db.query("folders").collect(),
      reservations: await ctx.db.query("creditReservations").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
    expect(state.profiles.map((p) => p.userId)).toEqual([mate.userId]);
    expect(state.apiKeys).toHaveLength(0);
    expect(state.folders).toHaveLength(0);
    expect(state.reservations).toHaveLength(0);
    const names = state.workspaces.map((w) => w.name).sort();
    expect(names).toContain("Shared");
    expect(names).not.toContain("Solo");
    expect(state.workspaces.find((w) => w.name === "Shared")?.ownerId).toBe(mate.userId);
    expect(state.memberships.every((m) => m.userId === mate.userId)).toBe(true);
    expect(state.memberships.find((m) => m.workspaceId === shared)?.role).toBe("owner");
    expect(state.audit.some((a) => a.action === "user.deleted")).toBe(true);
    expect(state.audit.some((a) => a.action === "workspace.ownershipTransferred")).toBe(true);
  });
});

describe("profiles", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("update validates input and syncs the Better Auth name", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await u.as.mutation(api.accounts.profiles.update, {
      name: "  New Name ",
      locale: "de-DE",
      timezone: "Europe/Berlin",
      appearance: { theme: "dark", density: "compact" },
    });
    const me = await u.as.query(api.accounts.profiles.me, {});
    expect(me).toMatchObject({
      locale: "de-DE",
      timezone: "Europe/Berlin",
      appearance: { theme: "dark", density: "compact" },
    });
    const authUser = await t.query(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: u.userId }],
    });
    expect((authUser as { name: string }).name).toBe("New Name");
    expect(
      (await errorData(u.as.mutation(api.accounts.profiles.update, { locale: "not a locale!" })))
        .code,
    ).toBe("INVALID_ARGUMENT");
    expect((await errorData(u.as.mutation(api.accounts.profiles.update, { name: "" }))).code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  test("onboarding and AI preferences; BYOK ciphertexts never reach the client", async () => {
    const t = setupTest();
    const u = await createUser(t);
    await u.as.mutation(api.accounts.profiles.setOnboarding, {
      step: "goals",
      useCases: ["social", "slides"],
    });
    await u.as.mutation(api.accounts.profiles.setOnboarding, { completed: true });
    await t.mutation(internal.accounts.profiles.setByokKey, {
      userId: u.userId,
      provider: "openai",
      ciphertext: "v1.secretblob.secretct",
      last4: "abcd",
    });
    await u.as.mutation(api.accounts.profiles.updateAiPreferences, {
      taskModels: { agent: { provider: "openrouter", model: "anthropic/claude-sonnet" } },
      preferByok: true,
    });
    const me = await u.as.query(api.accounts.profiles.me, {});
    expect(me?.onboarding).toMatchObject({
      completed: true,
      step: "goals",
      useCases: ["social", "slides"],
    });
    expect(me?.onboarding.completedAt).toBeTypeOf("number");
    expect(me?.aiSettings?.byok.openai).toMatchObject({ configured: true, last4: "abcd" });
    expect(JSON.stringify(me)).not.toContain("secretblob");
    const internalView = await t.query(internal.accounts.profiles.getAiSettings, {
      userId: u.userId,
    });
    expect(internalView?.byok?.openai?.ciphertext).toBe("v1.secretblob.secretct");
    await u.as.mutation(api.accounts.profiles.updateAiPreferences, { keyMode: "local" });
    expect(
      (await t.query(internal.accounts.profiles.getAiSettings, { userId: u.userId }))?.byok,
    ).toBeUndefined();
  });

  test("feature flags override plan features in me()", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const t = setupTest();
    const u = await createUser(t);
    expect((await u.as.query(api.accounts.profiles.me, {}))?.features["ai.images"]).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.insert("featureFlags", {
        key: "feature.ai.images",
        enabled: true,
        userIds: [u.userId],
        updatedAt: Date.now(),
      });
    });
    expect((await u.as.query(api.accounts.profiles.me, {}))?.features["ai.images"]).toBe(true);
  });
});

describe("admin", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("self-host: first user is admin; admin functions are guarded", async () => {
    vi.stubEnv("DESYN_EDITION", "selfhost");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_should_never_leak");
    const t = setupTest();
    const admin = await createUser(t);
    const user = await createUser(t);
    expect((await admin.as.query(api.accounts.profiles.me, {}))?.isAdmin).toBe(true);
    expect((await errorData(user.as.query(api.admin.system.status, {}))).code).toBe("FORBIDDEN");

    const status = await admin.as.query(api.admin.system.status, {});
    expect(status.billing.stripe).toBe(true);
    expect(JSON.stringify(status)).not.toContain("sk_should_never_leak");

    const list = await admin.as.query(api.admin.users.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(list.page).toHaveLength(2);
    const search = await admin.as.query(api.admin.users.list, {
      search: user.email.slice(0, 5),
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(search.page.map((p) => p.userId)).toContain(user.userId);

    await admin.as.mutation(api.admin.users.setRole, { userId: user.userId, role: "admin" });
    await user.as.mutation(api.admin.users.setRole, { userId: user.userId, role: "user" });
    expect(
      (
        await errorData(
          admin.as.mutation(api.admin.users.setRole, { userId: admin.userId, role: "user" }),
        )
      ).code,
    ).toBe("CONFLICT");
    await admin.as.mutation(api.admin.users.setDisabled, { userId: user.userId, disabled: true });
    expect((await errorData(user.as.query(api.accounts.workspaces.list, {}))).code).toBe(
      "UNAUTHENTICATED",
    );

    const overview = await admin.as.query(api.admin.system.usageOverview, {});
    expect(overview.users).toBe(2);
    const health = await admin.as.query(api.admin.system.health, {});
    expect(health.ok).toBe(true);

    await admin.as.mutation(api.admin.flags.set, {
      key: "feature.ai.images",
      enabled: false,
      plans: ["pro"],
    });
    expect((await admin.as.query(api.admin.flags.list, {})).flags.map((f) => f.key)).toEqual([
      "feature.ai.images",
    ]);
    await admin.as.mutation(api.admin.flags.remove, { key: "feature.ai.images" });
  });

  test("hosted: admins come from ADMIN_EMAILS and can override plans", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    vi.stubEnv("ADMIN_EMAILS", "boss@desyn.app, other@desyn.app");
    const t = setupTest();
    const boss = await createUser(t, { email: "boss@desyn.app" });
    const user = await createUser(t);
    expect((await user.as.query(api.accounts.profiles.me, {}))?.isAdmin).toBe(false);
    await boss.as.mutation(api.admin.users.setPlanOverride, { userId: user.userId, plan: "pro" });
    const me = await user.as.query(api.accounts.profiles.me, {});
    expect(me?.plan).toBe("pro");
    expect((await user.as.query(api.billing.credits.balance, {})).granted).toBe(600);
    const adjusted = await boss.as.mutation(api.admin.users.adjustUserCredits, {
      userId: user.userId,
      delta: 50,
      note: "support",
    });
    expect(adjusted.granted).toBe(650);
    const detail = await boss.as.query(api.admin.users.get, { userId: user.userId });
    expect(detail).toMatchObject({ plan: "pro", planOverride: "pro", credits: { granted: 650 } });
  });
});

describe("health route", () => {
  test("GET /healthz reports liveness without configuration details", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_never_returned");
    const t = setupTest();
    const res = await t.fetch("/healthz", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, service: "desyn-convex" });
    expect(JSON.stringify(body)).not.toContain("sk_");
    vi.unstubAllEnvs();
  });
});

describe("usage summary", () => {
  test("reports meters against plan limits", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const t = setupTest();
    const u = await createUser(t);
    await t.mutation(internal.billing.usage.increment, {
      userId: u.userId,
      metric: "designs",
      delta: 5,
    });
    await t.mutation(internal.billing.usage.increment, {
      userId: u.userId,
      metric: "storageBytes",
      delta: 512 * 1024 * 1024,
    });
    await t.mutation(internal.billing.usage.increment, {
      userId: u.userId,
      metric: "exports",
      delta: 2,
    });
    const summary = await u.as.query(api.billing.usage.summary, {});
    expect(summary.plan).toBe("free");
    expect(summary.meters.designs).toEqual({ used: 5, limit: 20, ratio: 0.25 });
    expect(summary.meters.storageBytes.ratio).toBeCloseTo(0.5);
    expect(summary.meters.exports.used).toBe(2);
    expect(summary.meters.workspaces).toMatchObject({ used: 1, limit: 1 });
    expect(summary.fairUse?.maxConcurrentRuns).toBe(3);
    vi.unstubAllEnvs();
  });
});
