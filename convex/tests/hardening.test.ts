import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import { createAuth } from "../auth";
import { isStaleUpdate } from "../billing/subscription";
import { MAX_ATTEMPTS, STUCK_SENDING_MS } from "../emails/queue";
import { logTransport } from "../emails/transport";
import { clientIpFrom, clientIpHeaders } from "../lib/env";
import { createUser, errorData, setupTest, type TestConvex } from "./harness.helpers";

// Regression tests for issues found in review: account linking trust, disabled accounts, admin
// email verification, Stripe same-second ordering, session management, mail recovery, log redaction.

const origin = "http://localhost:4104";

function stubAuthEnv() {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-at-least-32-chars");
  vi.stubEnv("APP_URL", origin);
  vi.stubEnv("SITE_URL", origin);
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
}

async function authFetch(t: TestConvex, path: string, body?: unknown) {
  return await t.fetch(`/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signUpAndVerify(t: TestConvex, email: string, password: string) {
  await authFetch(t, "/sign-up/email", { email, password, name: "Ada Lovelace" });
  const outbox = await t.run(async (ctx) => ctx.db.query("mailOutbox").collect());
  const link = outbox
    .map((o) => o.text.match(/https?:\/\/\S+verify-email\S+/)?.[0])
    .find((l) => l !== undefined);
  if (!link) throw new Error("no verification link");
  const url = new URL(link);
  await t.fetch(`${url.pathname}${url.search}`, { method: "GET", headers: { origin } });
}

describe("Better Auth hardening", () => {
  beforeEach(() => {
    stubAuthEnv();
    vi.stubEnv("DESYN_EDITION", "selfhost");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
    vi.stubEnv("GITHUB_CLIENT_ID", "github-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-client-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  test("OAuth providers are never trusted past email verification and no token-minting plugin is enabled", async () => {
    const t = setupTest();
    const options = await t.run(async (ctx) => {
      const { account, socialProviders, plugins } = createAuth(ctx).options;
      return {
        linkingEnabled: account?.accountLinking?.enabled ?? null,
        // The option is absent from the narrowed config type when unset; read it structurally.
        trustedProviders:
          (account?.accountLinking as { trustedProviders?: string[] } | undefined)
            ?.trustedProviders ?? null,
        providers: Object.keys(socialProviders ?? {}).sort(),
        pluginIds: (plugins ?? []).map((p) => p.id),
      };
    });
    expect(options.linkingEnabled).toBe(true);
    expect(options.trustedProviders).toBeNull();
    expect(options.providers).toEqual(["github", "google"]);
    expect(options.pluginIds).toContain("magic-link");
    expect(options.pluginIds).not.toContain("one-time-token");
  });

  test("spoofed CF-Connecting-IP headers do not bypass the sign-in rate limit", async () => {
    const t = setupTest();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await t.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-real-ip": "203.0.113.9",
          "cf-connecting-ip": `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({ email: "victim@example.com", password: "guess number one" }),
      });
      statuses.push(res.status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(clientIpHeaders()).toEqual(["x-real-ip", "x-forwarded-for"]);
    vi.stubEnv("AUTH_IP_HEADERS", "CF-Connecting-IP, x-real-ip, bad header");
    expect(clientIpHeaders()).toEqual(["cf-connecting-ip", "x-real-ip"]);
    expect(
      clientIpFrom(new Headers({ "x-real-ip": "203.0.113.9", "cf-connecting-ip": "192.0.2.1" })),
    ).toBe("192.0.2.1");
  });

  test("a disabled account cannot start a new session", async () => {
    const t = setupTest();
    await signUpAndVerify(t, "ada@example.com", "analytical engine");
    const ok = await authFetch(t, "/sign-in/email", {
      email: "ada@example.com",
      password: "analytical engine",
    });
    expect(ok.status).toBe(200);

    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", "ada@example.com"))
        .unique();
      if (!profile) throw new Error("profile");
      await ctx.db.patch("profiles", profile._id, { disabled: true });
    });
    const blocked = await authFetch(t, "/sign-in/email", {
      email: "ada@example.com",
      password: "analytical engine",
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { message?: string }).message).toBe(
      "This account is disabled.",
    );
  });
});

describe("hosted admins", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("ADMIN_EMAILS only grants admin to a verified address", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    vi.stubEnv("ADMIN_EMAILS", "boss@desyn.app");
    const t = setupTest();
    const unverified = await createUser(t, { email: "boss@desyn.app", emailVerified: false });
    expect((await unverified.as.query(api.accounts.profiles.me, {}))?.isAdmin).toBe(false);
    expect((await errorData(unverified.as.query(api.admin.system.status, {}))).code).toBe(
      "FORBIDDEN",
    );

    const t2 = setupTest();
    const verified = await createUser(t2, { email: "boss@desyn.app", emailVerified: true });
    expect((await verified.as.query(api.accounts.profiles.me, {}))?.isAdmin).toBe(true);
    const status = await verified.as.query(api.admin.system.status, {});
    expect(status.edition).toBe("hosted");
  });
});

describe("stripe ordering", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("same-second events never move a subscription back to incomplete", () => {
    const active = { lastEventCreated: 100, status: "active" as const };
    expect(isStaleUpdate(active, "incomplete", 100)).toBe(true);
    expect(isStaleUpdate(active, "canceled", 100)).toBe(false);
    expect(isStaleUpdate(active, "incomplete", 101)).toBe(false);
    expect(isStaleUpdate(active, "active", 99)).toBe(true);
    expect(isStaleUpdate({ lastEventCreated: 100, status: "incomplete" }, "incomplete", 100)).toBe(
      false,
    );
  });

  test("an out-of-order created(incomplete) event in the same second keeps the user on Pro", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const t = setupTest();
    const u = await createUser(t);
    const sub = (status: string) => ({
      id: "sub_tie",
      customer: "cus_tie",
      status,
      cancel_at_period_end: false,
      metadata: { userId: u.userId },
      items: { data: [{ price: { id: "price_m", recurring: { interval: "month" } } }] },
    });
    const created = 1_790_000_000;
    const first = await t.mutation(internal.billing.webhook.processEvent, {
      id: "evt_upd",
      type: "customer.subscription.updated",
      created,
      object: sub("active"),
    });
    expect(first.outcome).toBe("processed");
    const second = await t.mutation(internal.billing.webhook.processEvent, {
      id: "evt_created",
      type: "customer.subscription.created",
      created,
      object: sub("incomplete"),
    });
    expect(second).toEqual({ outcome: "ignored", note: "stale" });
    expect((await u.as.query(api.accounts.profiles.me, {}))?.plan).toBe("pro");
  });
});

describe("session management", () => {
  test("lists own sessions, revokes one, and cannot touch another user's session", async () => {
    const t = setupTest();
    const a = await createUser(t);
    const b = await createUser(t);
    // A second session for user A (e.g. a phone).
    const now = Date.now();
    const other = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          userId: a.userId,
          token: `phone-${now}`,
          expiresAt: now + 86_400_000,
          createdAt: now,
          updatedAt: now,
          userAgent: "Desyn iOS",
        },
      },
    })) as { _id: string };

    const sessions = await a.as.query(api.accounts.sessions.list, {});
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.current)?.id).toBe(a.sessionId);
    expect(sessions.find((s) => !s.current)).toMatchObject({ userAgent: "Desyn iOS" });
    expect(JSON.stringify(sessions)).not.toContain("phone-");

    // B cannot revoke A's session.
    expect(
      (await errorData(b.as.mutation(api.accounts.sessions.revoke, { sessionId: other._id }))).code,
    ).toBe("NOT_FOUND");
    expect(await a.as.query(api.accounts.sessions.list, {})).toHaveLength(2);

    expect(await a.as.mutation(api.accounts.sessions.revokeOthers, {})).toEqual({ revoked: 1 });
    const left = await a.as.query(api.accounts.sessions.list, {});
    expect(left.map((s) => s.id)).toEqual([a.sessionId]);
    // B is untouched.
    expect(await b.as.query(api.accounts.sessions.list, {})).toHaveLength(1);

    // Revoking the current session signs A out of Desyn functions.
    await a.as.mutation(api.accounts.sessions.revoke, { sessionId: a.sessionId });
    expect((await errorData(a.as.query(api.accounts.workspaces.list, {}))).code).toBe(
      "UNAUTHENTICATED",
    );
  });
});

describe("mail delivery recovery", () => {
  afterEach(() => vi.useRealTimers());

  test("sends whose action died are retried, or abandoned after the last attempt", async () => {
    const t = setupTest();
    const old = Date.now() - STUCK_SENDING_MS - 1000;
    const ids = await t.run(async (ctx) => {
      const make = async (attempts: number, lastAttemptAt: number) => {
        const id = await ctx.db.insert("mailLog", {
          to: "a@example.com",
          template: "welcome",
          subject: "Welcome",
          status: "sending",
          attempts,
          lastAttemptAt,
          createdAt: lastAttemptAt,
        });
        await ctx.db.insert("mailOutbox", { mailLogId: id, html: "<p/>", text: "t", createdAt: 0 });
        return id;
      };
      return {
        retry: await make(1, old),
        abandon: await make(MAX_ATTEMPTS, old),
        fresh: await make(1, Date.now()),
      };
    });
    const result = await t.mutation(internal.emails.queue.recoverStuck, {});
    expect(result).toEqual({ retried: 1, abandoned: 1 });
    const rows = await t.run(async (ctx) => ({
      retry: await ctx.db.get("mailLog", ids.retry),
      abandon: await ctx.db.get("mailLog", ids.abandon),
      fresh: await ctx.db.get("mailLog", ids.fresh),
      outbox: await ctx.db.query("mailOutbox").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(rows.retry).toMatchObject({ status: "failed", error: "delivery timed out" });
    expect(rows.abandon).toMatchObject({ status: "failed", error: "delivery timed out" });
    expect(rows.fresh?.status).toBe("sending");
    expect(rows.outbox.map((o) => o.mailLogId).sort()).toEqual([ids.retry, ids.fresh].sort());
    expect(rows.scheduled.map((s) => s.args[0])).toEqual([{ mailLogId: ids.retry }]);
  });
});

describe("log transport", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("omits message bodies (and their links) on the hosted edition", async () => {
    vi.stubEnv("DESYN_EDITION", "hosted");
    const lines: string[] = [];
    await logTransport((l) => lines.push(l)).send({
      to: "a@example.com",
      subject: "Sign in to Desyn",
      html: "<a href='https://app.desyn.app/api/auth/magic-link/verify?token=secret'>x</a>",
      text: "https://app.desyn.app/api/auth/magic-link/verify?token=secret",
    });
    expect(lines[0]).not.toContain("token=secret");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      to: "a@example.com",
      subject: "Sign in to Desyn",
    });
  });
});

describe("AI preference limits", () => {
  test("oversized preferences are rejected before they bloat the profile", async () => {
    const t = setupTest();
    const u = await createUser(t);
    const big = { blob: "x".repeat(20 * 1024) };
    expect(
      (await errorData(u.as.mutation(api.accounts.profiles.updateAiPreferences, { prefs: big })))
        .code,
    ).toBe("INVALID_ARGUMENT");
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`task${i}`, { provider: "openrouter", model: "m" }]),
    );
    expect(
      (
        await errorData(
          u.as.mutation(api.accounts.profiles.updateAiPreferences, { taskModels: many }),
        )
      ).field,
    ).toBe("taskModels");
    // Small updates still merge.
    await u.as.mutation(api.accounts.profiles.updateAiPreferences, { prefs: { a: 1 } });
    await u.as.mutation(api.accounts.profiles.updateAiPreferences, { prefs: { b: 2 } });
    expect((await u.as.query(api.accounts.profiles.me, {}))?.aiSettings?.prefs).toEqual({
      a: 1,
      b: 2,
    });
  });
});
