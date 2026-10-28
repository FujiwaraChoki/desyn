"use client";

import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth client. It talks to this app's own origin (/api/auth/*), which the route handler in
 * app/api/auth/[...all] forwards to the Convex site URL, so session cookies stay first-party.
 */
export const authClient = createAuthClient({
  plugins: [convexClient(), magicLinkClient()],
});

export type AuthClient = typeof authClient;
