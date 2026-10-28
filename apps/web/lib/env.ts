/*
 * Public configuration of the web app. Only NEXT_PUBLIC_* values may be read here: they are inlined
 * into client bundles at build time (literal `process.env.NAME` accesses are required for that).
 */

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

export const publicEnv = {
  convexUrl: clean(process.env.NEXT_PUBLIC_CONVEX_URL),
  convexSiteUrl: clean(process.env.NEXT_PUBLIC_CONVEX_SITE_URL),
  appUrl: clean(process.env.NEXT_PUBLIC_APP_URL) ?? "http://localhost:4100",
  siteUrl: clean(process.env.NEXT_PUBLIC_SITE_URL) ?? "https://desyn.app",
  docsUrl: clean(process.env.NEXT_PUBLIC_DOCS_URL) ?? "https://docs.desyn.app",
  edition: process.env.NEXT_PUBLIC_DESYN_EDITION === "hosted" ? "hosted" : "selfhost",
  posthogKey: clean(process.env.NEXT_PUBLIC_POSTHOG_KEY),
  posthogHost: clean(process.env.NEXT_PUBLIC_POSTHOG_HOST) ?? "https://eu.i.posthog.com",
  datafastWebsiteId: clean(process.env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID),
  datafastDomain: clean(process.env.NEXT_PUBLIC_DATAFAST_DOMAIN),
} as const;

export type PublicEnv = typeof publicEnv;
