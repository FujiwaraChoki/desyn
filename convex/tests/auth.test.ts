import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { setupTest } from "./harness.helpers";

const origin = "http://localhost:4104";

async function authFetch(
  t: ReturnType<typeof setupTest>,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return await t.fetch(`/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Better Auth integration", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-at-least-32-chars");
    vi.stubEnv("APP_URL", origin);
    vi.stubEnv("SITE_URL", origin);
    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
    vi.stubEnv("DESYN_EDITION", "selfhost");
  });
  afterEach(() => vi.unstubAllEnvs());

  test("email sign-up provisions the account, sends verification and blocks unverified sign-in", async () => {
    const t = setupTest();
    const signUp = await authFetch(t, "/sign-up/email", {
      email: "Grace@Example.com",
      password: "correct horse battery",
      name: "Grace Hopper",
    });
    expect(signUp.status).toBe(200);
    const profiles = await t.run(async (ctx) => ctx.db.query("profiles").collect());
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      email: "grace@example.com",
      name: "Grace Hopper",
      role: "admin",
    });
    const workspaces = await t.run(async (ctx) => ctx.db.query("workspaces").collect());
    expect(workspaces).toHaveLength(1);
    const mail = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    expect(mail.map((m) => m.template)).toEqual(["verifyEmail"]);
    const outbox = await t.run(async (ctx) => ctx.db.query("mailOutbox").collect());
    expect(outbox[0]?.text).toContain(`${origin}/api/auth/verify-email?token=`);

    const signIn = await authFetch(t, "/sign-in/email", {
      email: "grace@example.com",
      password: "correct horse battery",
    });
    expect(signIn.status).toBe(403);

    // Second user on self-host is not an admin.
    await authFetch(t, "/sign-up/email", {
      email: "second@example.com",
      password: "another long pass",
      name: "Second",
    });
    const second = (await t.run(async (ctx) => ctx.db.query("profiles").collect())).find(
      (p) => p.email === "second@example.com",
    );
    expect(second?.role).toBe("user");
  });

  test("verification link verifies, signs in, and a bearer session token yields a Convex JWT", async () => {
    const t = setupTest();
    await authFetch(t, "/sign-up/email", {
      email: "lin@example.com",
      password: "a strong password",
      name: "Lin",
    });
    const outbox = await t.run(async (ctx) => ctx.db.query("mailOutbox").collect());
    const link = outbox[0]?.text.match(/https?:\/\/\S+verify-email\S+/)?.[0];
    if (!link) throw new Error("no link");
    const url = new URL(link);
    const verify = await t.fetch(`${url.pathname}${url.search}`, {
      method: "GET",
      headers: { origin },
    });
    expect([200, 302]).toContain(verify.status);

    const signIn = await authFetch(t, "/sign-in/email", {
      email: "lin@example.com",
      password: "a strong password",
    });
    expect(signIn.status).toBe(200);
    const body = (await signIn.json()) as { token: string; user: { id: string } };
    expect(body.token).toBeTruthy();

    const session = await authFetch(t, "/get-session", undefined, {
      authorization: `Bearer ${body.token}`,
    });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
      "lin@example.com",
    );

    const jwt = await authFetch(t, "/convex/token", undefined, {
      authorization: `Bearer ${body.token}`,
    });
    expect(jwt.status).toBe(200);
    expect(((await jwt.json()) as { token: string }).token.split(".")).toHaveLength(3);

    // Welcome mail goes out once the email is verified.
    const templates = (await t.run(async (ctx) => ctx.db.query("mailLog").collect())).map(
      (m) => m.template,
    );
    expect(templates).toContain("welcome");
  });

  test("wrong passwords are rate limited", async () => {
    const t = setupTest();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await authFetch(
        t,
        "/sign-in/email",
        { email: "nobody@example.com", password: "wrong password" },
        {
          "x-real-ip": "198.51.100.7",
        },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  test("magic link requests queue a sign-in email", async () => {
    const t = setupTest();
    const res = await authFetch(t, "/sign-in/magic-link", {
      email: "magic@example.com",
      callbackURL: "/",
    });
    expect(res.status).toBe(200);
    const mail = await t.run(async (ctx) => ctx.db.query("mailLog").collect());
    expect(mail.map((m) => [m.template, m.to])).toEqual([["magicLink", "magic@example.com"]]);
  });

  test("public config lists enabled sign-in methods", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "gh-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "gh-secret");
    const t = setupTest();
    const config = await t.query(api.accounts.config.get, {});
    expect(config.authMethods).toEqual({
      emailPassword: true,
      magicLink: true,
      google: false,
      github: true,
    });
    expect(config.billingEnabled).toBe(false);
  });
});
