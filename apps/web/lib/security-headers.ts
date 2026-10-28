/*
 * Security headers and the Content-Security-Policy for app.desyn.app. Pure functions so they can be
 * unit-tested and used from next.config.ts (headers are computed at build time from the env).
 *
 * The hosted deployment's nginx sends an equivalent policy (deploy/nginx/desyn/snippets/csp-app.conf);
 * when both are present the browser enforces the intersection, so this policy must never be stricter
 * than nginx's for the hosts the app needs. Set DESYN_SECURITY_HEADERS=off to leave headers to the proxy.
 */

export interface CspInput {
  convexUrl?: string | undefined;
  convexSiteUrl?: string | undefined;
  posthogHost?: string | undefined;
  /** S3_PUBLIC_BASE_URL or S3_ENDPOINT (MinIO/R2), when assets are served from a custom host. */
  assetOrigins?: (string | undefined)[];
  dev?: boolean;
}

/** `https://host[:port]` of a URL, or undefined when it does not parse. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** The websocket origin of a Convex deployment URL (`https://x.convex.cloud` -> `wss://x.convex.cloud`). */
export function websocketOrigin(url: string | undefined): string | undefined {
  const origin = originOf(url);
  if (!origin) return undefined;
  return origin.replace(/^http/, "ws");
}

/** PostHog's asset host for a given ingestion host (eu.i.posthog.com -> eu-assets.i.posthog.com). */
export function posthogAssetsOrigin(host: string | undefined): string | undefined {
  const origin = originOf(host);
  if (!origin) return undefined;
  const u = new URL(origin);
  const match = /^(eu|us)\.i\.posthog\.com$/.exec(u.hostname);
  return match ? `https://${match[1]}-assets.i.posthog.com` : origin;
}

function unique(values: (string | undefined | false)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

export function buildCsp(input: CspInput): string {
  const convex = originOf(input.convexUrl);
  const convexWs = websocketOrigin(input.convexUrl);
  const convexSite = originOf(input.convexSiteUrl);
  const posthog = originOf(input.posthogHost) ?? "https://eu.i.posthog.com";
  const posthogAssets = posthogAssetsOrigin(input.posthogHost) ?? "https://eu-assets.i.posthog.com";
  const assets = unique((input.assetOrigins ?? []).map(originOf));
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'unsafe-inline': the theme boot script and Next's inline RSC payload; 'wasm-unsafe-eval': the
    // rendering engine. React Refresh needs 'unsafe-eval' in development only.
    "script-src": unique([
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      input.dev && "'unsafe-eval'",
      posthogAssets,
      "https://datafa.st",
      "https://js.stripe.com",
    ]),
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": unique(["'self'", "data:", "blob:", "https:", ...assets]),
    "media-src": unique(["'self'", "data:", "blob:", "https:", ...assets]),
    // User fonts: Google Fonts files and uploaded fonts from the asset bucket.
    "font-src": unique(["'self'", "data:", "https://fonts.gstatic.com", ...assets]),
    // `https:` because BYOK users in "local keys" mode call their own provider endpoints from the
    // browser and uploads go to presigned S3 URLs; localhost for browser-run local models (Ollama).
    "connect-src": unique([
      "'self'",
      convex,
      convexWs,
      convexSite,
      posthog,
      posthogAssets,
      "https://datafa.st",
      ...assets,
      "https:",
      "http://localhost:*",
      "http://127.0.0.1:*",
      "ws://localhost:*",
      "ws://127.0.0.1:*",
    ]),
    "worker-src": ["'self'", "blob:"],
    "child-src": ["'self'", "blob:"],
    "frame-src": ["'self'", "https://js.stripe.com", "https://checkout.stripe.com"],
    "frame-ancestors": ["'self'"],
    "form-action": ["'self'", "https://checkout.stripe.com", "https://billing.stripe.com"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "manifest-src": ["'self'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export interface HeaderInput extends CspInput {
  appUrl?: string | undefined;
}

export function securityHeaders(input: HeaderInput): { key: string; value: string }[] {
  const headers = [
    { key: "Content-Security-Policy", value: buildCsp(input) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  ];
  if (!input.dev && input.appUrl?.startsWith("https://")) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    });
  }
  return headers;
}
