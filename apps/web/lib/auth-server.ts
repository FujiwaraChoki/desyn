import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

type AuthServer = ReturnType<typeof convexBetterAuthNextJs>;
let instance: AuthServer | null = null;

/**
 * Server-side Better Auth helpers (token for server-rendered Convex calls, the /api/auth proxy).
 * Created lazily: the Convex URLs are runtime configuration and may be absent while building.
 */
export function authServer(): AuthServer {
  if (instance) return instance;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  const convexSiteUrl = (
    process.env.CONVEX_SITE_URL ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL
  )?.trim();
  if (!convexUrl || !convexSiteUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL and NEXT_PUBLIC_CONVEX_SITE_URL must be set.");
  }
  instance = convexBetterAuthNextJs({
    convexUrl,
    convexSiteUrl: convexSiteUrl.replace(/\/+$/, ""),
  });
  return instance;
}
