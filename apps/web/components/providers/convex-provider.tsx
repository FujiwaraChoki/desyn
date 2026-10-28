"use client";

import { type AuthClient, ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { publicEnv } from "@/lib/env";

let client: ConvexReactClient | null = null;

// The provider's AuthClient type is computed for a fixed plugin list and collapses `useSession().data`
// to `never` once other plugins (magic link) are added. The runtime contract it needs (useSession,
// convex.token) is unaffected, so the client is passed through the declared type.
const providerAuthClient = authClient as unknown as AuthClient;

function convexClient(url: string): ConvexReactClient {
  client ??= new ConvexReactClient(url, { verbose: false });
  return client;
}

/** Convex realtime client authenticated through Better Auth (session cookie -> Convex JWT). */
export function ConvexProvider({ children }: { children: ReactNode }) {
  if (!publicEnv.convexUrl) return <MissingConfig />;
  return (
    <ConvexBetterAuthProvider
      client={convexClient(publicEnv.convexUrl)}
      authClient={providerAuthClient}
    >
      {children}
    </ConvexBetterAuthProvider>
  );
}

function MissingConfig() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-fg">
      <div className="max-w-md text-center">
        <h1 className="font-serif text-4xl">Desyn is not configured</h1>
        <p className="mt-3 text-sm text-fg-muted">
          Set <code className="font-mono text-fg">NEXT_PUBLIC_CONVEX_URL</code> and{" "}
          <code className="font-mono text-fg">NEXT_PUBLIC_CONVEX_SITE_URL</code> to your Convex
          deployment, then rebuild the web app.
        </p>
      </div>
    </main>
  );
}
