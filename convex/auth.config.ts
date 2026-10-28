import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

// Convex validates Better Auth JWTs (RS256) against the JWKS served by our own HTTP routes.
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
