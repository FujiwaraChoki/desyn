import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security-headers";

// The monorepo root: the app imports workspace packages and the generated Convex API (../../convex).
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dev = process.env.NODE_ENV === "development";
const convexSiteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL?.trim().replace(/\/+$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@desyn/ui",
    "@desyn/tokens",
    "@desyn/schema",
    "@desyn/doc-ops",
    "@desyn/ai",
    "@desyn/engine",
    "@desyn/editor",
  ],
  async headers() {
    if (process.env.DESYN_SECURITY_HEADERS === "off") return [];
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          dev,
          appUrl: process.env.NEXT_PUBLIC_APP_URL,
          convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
          convexSiteUrl,
          posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
          assetOrigins: [process.env.S3_PUBLIC_BASE_URL, process.env.S3_ENDPOINT],
        }),
      },
    ];
  },
  async rewrites() {
    if (!convexSiteUrl) return [];
    // The Agent API, MCP and OG metadata live on the Convex site URL. In production nginx serves
    // these paths before they reach Next; the rewrites make local and self-hosted setups behave the
    // same. Better Auth (/api/auth/*) is proxied by app/api/auth/[...all]/route.ts instead, which
    // forwards the client IP and rewrites host headers as @convex-dev/better-auth expects.
    return [
      { source: "/api/v1/:path*", destination: `${convexSiteUrl}/api/v1/:path*` },
      { source: "/mcp", destination: `${convexSiteUrl}/mcp` },
      { source: "/mcp/:path*", destination: `${convexSiteUrl}/mcp/:path*` },
      { source: "/og/:token", destination: `${convexSiteUrl}/og/:token` },
    ];
  },
};

export default nextConfig;
