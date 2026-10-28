// Environment access by NAME only. Values are read at call time (Convex env vars can change without a redeploy)
// and never logged or returned to clients; status helpers only expose booleans.

export type Edition = "hosted" | "selfhost";

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const env = {
  get: read,
  has: (name: string) => read(name) !== undefined,
  require(name: string): string {
    const value = read(name);
    if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
    return value;
  },
};

/** `DESYN_EDITION=hosted` enables billing and plan gating; anything else is the self-hosted edition. */
export function edition(): Edition {
  return read("DESYN_EDITION") === "hosted" ? "hosted" : "selfhost";
}

export function isHosted(): boolean {
  return edition() === "hosted";
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Public URL of the web app (auth links, email links). */
export function appUrl(): string {
  return stripSlash(read("APP_URL") ?? read("SITE_URL") ?? "http://localhost:4104");
}

/** Public URL of the marketing site. */
export function siteUrl(): string {
  return stripSlash(read("SITE_URL") ?? appUrl());
}

/** The Convex HTTP actions origin (set automatically by Convex). */
export function convexSiteUrl(): string | undefined {
  const url = read("CONVEX_SITE_URL");
  return url ? stripSlash(url) : undefined;
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Request headers carrying the client IP, most trusted first. The default trusts `X-Real-IP`, which
 * the deployment's nginx overwrites with the peer address, then the first `X-Forwarded-For` hop.
 * Headers a client can set freely (e.g. `CF-Connecting-IP` without Cloudflare in front) must not
 * be listed, or per-IP rate limits can be bypassed. Behind Cloudflare set
 * `AUTH_IP_HEADERS=cf-connecting-ip,x-real-ip`.
 */
export function clientIpHeaders(): string[] {
  const configured = (read("AUTH_IP_HEADERS") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9-]+$/.test(h));
  return configured.length > 0 ? configured : ["x-real-ip", "x-forwarded-for"];
}

/** First client IP found in the trusted headers (see `clientIpHeaders`). */
export function clientIpFrom(headers: Headers): string | undefined {
  for (const name of clientIpHeaders()) {
    const value = headers.get(name)?.split(",")[0]?.trim();
    if (value) return value.slice(0, 64);
  }
  return undefined;
}

/** Comma separated `ADMIN_EMAILS`, lowercased. */
export function adminEmails(): string[] {
  return (read("ADMIN_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function mailTransportName(): "ses" | "smtp" | "log" {
  const value = read("MAIL_TRANSPORT");
  if (value === "ses" || value === "smtp") return value;
  return "log";
}

export function mailFrom(): string {
  return read("MAIL_FROM") ?? read("SES_FROM") ?? "Desyn <hello@desyn.app>";
}

/** Booleans describing which integrations are configured. Never includes values. */
export function integrationStatus() {
  const ses = mailTransportName() === "ses" && env.has("SES_FROM");
  const smtp = mailTransportName() === "smtp" && env.has("SMTP_URL");
  return {
    edition: edition(),
    auth: {
      secret: env.has("BETTER_AUTH_SECRET"),
      google: env.has("GOOGLE_CLIENT_ID") && env.has("GOOGLE_CLIENT_SECRET"),
      github: env.has("GITHUB_CLIENT_ID") && env.has("GITHUB_CLIENT_SECRET"),
    },
    mail: { transport: mailTransportName(), ready: ses || smtp || mailTransportName() === "log" },
    billing: {
      stripe: env.has("STRIPE_SECRET_KEY"),
      webhook: env.has("STRIPE_WEBHOOK_SECRET"),
      priceMonthly: env.has("STRIPE_PRICE_PRO_MONTHLY"),
      priceYearly: env.has("STRIPE_PRICE_PRO_YEARLY"),
    },
    ai: {
      anthropic: env.has("ANTHROPIC_API_KEY"),
      openrouter: env.has("OPENROUTER_API_KEY"),
      openai: env.has("OPENAI_API_KEY"),
      google: env.has("GOOGLE_GENERATIVE_AI_API_KEY"),
      fal: env.has("FAL_AI_API_KEY") || env.has("FAL_KEY"),
      ollama: env.has("OLLAMA_BASE_URL"),
      byokEncryption: env.has("AI_KEY_ENCRYPTION_SECRET"),
    },
    storage: {
      s3: env.has("S3_BUCKET"),
      customEndpoint: env.has("S3_ENDPOINT"),
      region: env.has("AWS_REGION"),
    },
    renderWorker: env.has("RENDER_WORKER_URL"),
    stock: { unsplash: env.has("UNSPLASH_ACCESS_KEY"), pexels: env.has("PEXELS_API_KEY") },
    telemetry: {
      axiom: env.has("AXIOM_TOKEN") && env.has("AXIOM_DATASET"),
      posthog: env.has("POSTHOG_PROJECT_API_KEY") || env.has("NEXT_PUBLIC_POSTHOG_KEY"),
    },
  };
}
export type IntegrationStatus = ReturnType<typeof integrationStatus>;
