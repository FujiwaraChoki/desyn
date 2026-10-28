"use client";

import { resetAnalytics } from "./analytics";
import { authClient } from "./auth-client";
import { bindLocalKeysToUser } from "./local-keys";

/**
 * Signs out of Desyn in this browser: ends the Better Auth session, unlinks the analytics identity
 * (the next person on this browser starts anonymous), unbinds the user's local BYOK keys and then
 * loads `to` with a full navigation.
 *
 * The full navigation matters: a client-side transition keeps the Convex client and Better Auth's
 * cached session alive for a moment, so live queries re-run without a token (UNAUTHENTICATED in the
 * error boundary) and /login can still see the old session and bounce back into the app.
 */
export async function signOut(to = "/login"): Promise<void> {
  resetAnalytics();
  bindLocalKeysToUser(null);
  try {
    await authClient.signOut();
  } finally {
    window.location.replace(to);
  }
}
