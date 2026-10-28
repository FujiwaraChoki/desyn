import betterAuthTest from "@convex-dev/better-auth/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { components, internal } from "../_generated/api";
import schema from "../schema";

// Test harness: a convex-test instance with the Better Auth and rate limiter components registered,
// plus helpers to create signed-in users exactly like the Better Auth triggers would.

export const modules = import.meta.glob([
  "../**/*.ts",
  "../**/*.js",
  "!../**/*.d.ts",
  "!../**/*.test.ts",
  "!../**/*.helpers.ts",
  "!../**/*.config.ts",
]);

export function setupTest() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t, "betterAuth");
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}

export type TestConvex = ReturnType<typeof setupTest>;

let counter = 0;

export interface TestUser {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  as: ReturnType<TestConvex["withIdentity"]>;
}

/** Create a Better Auth user + live session, run the onCreate trigger, and return an identity. */
export async function createUser(
  t: TestConvex,
  opts: { email?: string; name?: string; emailVerified?: boolean } = {},
): Promise<TestUser> {
  counter++;
  const email = (opts.email ?? `user${counter}@example.com`).toLowerCase();
  const name = opts.name ?? `Test User${counter}`;
  const now = Date.now();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name,
        email,
        emailVerified: opts.emailVerified ?? true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string; name: string; email: string; emailVerified: boolean };
  await t.mutation(internal.auth.onCreate, { model: "user", doc: user });
  const session = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        token: `token-${counter}-${now}`,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };
  const as = t.withIdentity({ subject: user._id, sessionId: session._id, email, name });
  return { userId: user._id, sessionId: session._id, email, name, as };
}

/** Read the ConvexError payload of a rejected promise. */
export async function errorData(
  promise: Promise<unknown>,
): Promise<{ code?: string; [k: string]: unknown }> {
  try {
    await promise;
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") return data as { code?: string };
    if (typeof data === "string") {
      try {
        return JSON.parse(data) as { code?: string };
      } catch {
        return { code: data };
      }
    }
    throw err;
  }
  throw new Error("expected promise to reject");
}
