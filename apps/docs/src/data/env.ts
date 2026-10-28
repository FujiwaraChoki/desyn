/**
 * Every environment variable from SPEC section 9, every variable the Convex functions read
 * (tests/generated.test.ts scans convex/ for them) and the worker's FONTS_DIR from the document
 * model, grouped for the configuration reference. Names only, never values.
 */
export type EnvTarget = "convex" | "web" | "worker";

export interface EnvVar {
  name: string;
  group: EnvGroupId;
  /** Where the variable is read. Convex variables are set with `npx convex env set`. */
  targets: EnvTarget[];
  required: "yes" | "no" | "conditional";
  /** When `required` is "conditional", the condition in a few words. */
  requiredWhen?: string;
  /** Default value, or undefined when there is none. */
  defaultValue?: string;
  secret: boolean;
  description: string;
  example?: string;
}

export type EnvGroupId =
  | "core"
  | "convex"
  | "storage"
  | "mail"
  | "ai"
  | "worker"
  | "auth"
  | "billing"
  | "stock"
  | "telemetry";

export const ENV_GROUPS: { id: EnvGroupId; title: string; intro: string }[] = [
  {
    id: "core",
    title: "Core",
    intro: "Identity of the installation, its public URLs and the secrets every deployment needs.",
  },
  {
    id: "convex",
    title: "Convex",
    intro:
      "Where the backend lives. The CLI variables are only needed on the machine that deploys functions.",
  },
  {
    id: "storage",
    title: "Object storage",
    intro:
      "File bytes (uploads, AI results, exports, snapshots) live in S3 or any S3-compatible store.",
  },
  {
    id: "mail",
    title: "Email",
    intro: "Verification, magic links, password resets, invites and receipts.",
  },
  {
    id: "ai",
    title: "AI providers",
    intro:
      "Server-side provider keys. All are optional: without them, members can still use their own keys (BYOK) or local models.",
  },
  {
    id: "worker",
    title: "Render worker",
    intro: "The Rust worker renders exports, thumbnails and previews for the AI.",
  },
  {
    id: "auth",
    title: "Sign-in providers",
    intro:
      "Optional OAuth providers. A provider's button appears only when its credentials are set.",
  },
  {
    id: "billing",
    title: "Billing (hosted edition)",
    intro:
      "Stripe is used only by the hosted edition. Self-hosted installations leave these unset.",
  },
  {
    id: "stock",
    title: "Stock media",
    intro: "Optional stock photo sources for the Photos panel and the agent's `search_stock` tool.",
  },
  {
    id: "telemetry",
    title: "Telemetry",
    intro:
      "All telemetry is optional and off when unset. With DESYN_EDITION=selfhost it stays off unless you configure it.",
  },
];

export const ENV_VARS: EnvVar[] = [
  // Core
  {
    name: "DESYN_EDITION",
    group: "core",
    targets: ["convex", "web"],
    required: "no",
    defaultValue: "selfhost",
    secret: false,
    description:
      "`hosted` for desyn.app; any other value (or none) means the self-hosted edition, which unlocks every feature for every account, disables billing and keeps telemetry off by default. Set it explicitly so the web app build and the backend agree.",
    example: "selfhost",
  },
  {
    name: "SITE_URL",
    group: "core",
    targets: ["convex", "web"],
    required: "yes",
    defaultValue: "APP_URL",
    secret: false,
    description:
      "Public origin of the Desyn site, used for absolute links. On a self-hosted installation this is usually the same origin as `APP_URL`; when unset it falls back to it.",
    example: "https://design.example.org",
  },
  {
    name: "APP_URL",
    group: "core",
    targets: ["convex", "web"],
    required: "yes",
    defaultValue: "SITE_URL",
    secret: false,
    description:
      "Public origin of the web app. Used for sign-in redirects, email links (verification, magic link, invites) and share links. When unset it falls back to `SITE_URL`.",
    example: "https://design.example.org",
  },
  {
    name: "BETTER_AUTH_SECRET",
    group: "core",
    targets: ["convex"],
    required: "yes",
    secret: true,
    description:
      "Signs sessions and auth tokens. Use at least 32 random bytes (`openssl rand -base64 32`). Rotating it signs everyone out.",
  },
  {
    name: "ADMIN_EMAILS",
    group: "core",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "Hosted edition only: comma-separated email addresses with access to the admin console. On a self-hosted installation the first account becomes an administrator and further admins are promoted in the console.",
    example: "ops@example.org,owner@example.org",
  },
  {
    name: "AUTH_TRUSTED_ORIGINS",
    group: "core",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "Additional origins, comma-separated, that may call the authentication routes. `APP_URL` and `SITE_URL` are always trusted; add others only if you serve the app from more than one origin.",
    example: "https://design.example.com",
  },
  {
    name: "AUTH_IP_HEADERS",
    group: "core",
    targets: ["convex"],
    required: "no",
    defaultValue: "x-real-ip,x-forwarded-for",
    secret: false,
    description:
      "Request headers, comma-separated and most trusted first, that carry the client IP for per-IP rate limits and session records. The first value found wins (for `X-Forwarded-For`, its first entry). List only headers your own proxy overwrites: a header clients can set freely lets them bypass the limits. Behind Cloudflare use `cf-connecting-ip,x-real-ip`.",
    example: "cf-connecting-ip,x-real-ip",
  },
  {
    name: "AI_KEY_ENCRYPTION_SECRET",
    group: "core",
    targets: ["convex"],
    required: "yes",
    secret: true,
    description:
      "Encrypts members' own provider keys (BYOK) at rest (AES-GCM). At least 16 characters; use 32 random bytes. If you lose or change it, stored keys can no longer be decrypted and members must enter them again.",
  },
  {
    name: "TEMPLATES_PIPELINE_SECRET",
    group: "core",
    targets: ["convex"],
    required: "no",
    secret: true,
    description:
      "Token that lets the template pipeline publish template bundles (`templates/admin:publish`) without a signed-in administrator. Leave it unset to allow publishing only from an admin session. If you set it, use 32 random bytes and give it only to the machine that runs the pipeline.",
  },
  {
    name: "MCP_ALLOWED_ORIGINS",
    group: "core",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "Extra browser origins allowed to call the MCP endpoint (`/mcp`), comma-separated (for example `https://claude.ai,https://chat.example.com`). The app and site URLs are always allowed; requests without an Origin header (desktop and CLI MCP clients) are unaffected.",
  },
  // Convex
  {
    name: "CONVEX_URL",
    group: "convex",
    targets: ["convex", "worker"],
    required: "yes",
    secret: false,
    description:
      "URL of the Convex deployment's client API (port 3210 on a default self-hosted backend). Server-side code uses this name. Convex provides it to its own functions automatically (from the backend's `CONVEX_CLOUD_ORIGIN`), so set it only for the web app and the worker.",
    example: "https://convex.example.org",
  },
  {
    name: "NEXT_PUBLIC_CONVEX_URL",
    group: "convex",
    targets: ["web"],
    required: "yes",
    secret: false,
    description:
      "The same URL as `CONVEX_URL`, exposed to the browser. It is inlined when the web app is built, so rebuild after changing it.",
    example: "https://convex.example.org",
  },
  {
    name: "CONVEX_SITE_URL",
    group: "convex",
    targets: ["convex", "web"],
    required: "yes",
    secret: false,
    description:
      "Origin that serves Convex HTTP actions (port 3211 on a default self-hosted backend): authentication routes, `/api/v1/*`, `/mcp`, `/healthz`, `/og/:id` and the Stripe webhook. Convex provides it to its own functions automatically (from the backend's `CONVEX_SITE_ORIGIN`); set it yourself only for the web app.",
    example: "https://convex-site.example.org",
  },
  {
    name: "CONVEX_SELF_HOSTED_URL",
    group: "convex",
    targets: [],
    required: "conditional",
    requiredWhen: "deploying to a self-hosted backend",
    secret: false,
    description:
      "Read by the Convex CLI (`npx convex deploy`) to find your self-hosted backend. Only needed where you run the CLI.",
    example: "https://convex.example.org",
  },
  {
    name: "CONVEX_SELF_HOSTED_ADMIN_KEY",
    group: "convex",
    targets: [],
    required: "conditional",
    requiredWhen: "deploying to a self-hosted backend",
    secret: true,
    description:
      "Admin key of the self-hosted backend, printed by its `generate_admin_key.sh` script. Grants full control of the deployment; keep it out of the web app's environment.",
  },
  // Storage
  {
    name: "S3_BUCKET",
    group: "storage",
    targets: ["convex", "worker"],
    required: "yes",
    secret: false,
    description:
      "Bucket that stores uploads, generated assets, exports, thumbnails and design snapshots.",
    example: "desyn",
  },
  {
    name: "AWS_REGION",
    group: "storage",
    targets: ["convex", "worker"],
    required: "yes",
    secret: false,
    description:
      "Region of the bucket (and of SES when `MAIL_TRANSPORT=ses`). S3-compatible stores that ignore regions still need a value such as `us-east-1`; Cloudflare R2 uses `auto`.",
    example: "eu-north-1",
  },
  {
    name: "AWS_ACCESS_KEY_ID",
    group: "storage",
    targets: ["convex", "worker"],
    required: "yes",
    secret: true,
    description:
      "Access key for the bucket (and SES). Scope it to the bucket and, if used, `ses:SendRawEmail`.",
  },
  {
    name: "AWS_SECRET_ACCESS_KEY",
    group: "storage",
    targets: ["convex", "worker"],
    required: "yes",
    secret: true,
    description: "Secret for `AWS_ACCESS_KEY_ID`.",
  },
  {
    name: "AWS_SESSION_TOKEN",
    group: "storage",
    targets: ["convex"],
    required: "no",
    secret: true,
    description:
      "Session token for temporary AWS credentials (STS). Leave unset with long-lived access keys, which is the usual setup.",
  },
  {
    name: "S3_ENDPOINT",
    group: "storage",
    targets: ["convex", "worker"],
    required: "no",
    defaultValue: "AWS S3",
    secret: false,
    description:
      "Custom endpoint for S3-compatible storage such as MinIO or Cloudflare R2. Leave unset for AWS S3. Browsers upload directly to presigned URLs on this endpoint, so it must be reachable from members' browsers.",
    example: "https://s3.example.org",
  },
  {
    name: "S3_FORCE_PATH_STYLE",
    group: "storage",
    targets: ["convex", "worker"],
    required: "no",
    defaultValue: "false",
    secret: false,
    description:
      "Set to `true` for stores that need path-style URLs (`endpoint/bucket/key`), which includes MinIO.",
    example: "true",
  },
  {
    name: "S3_PUBLIC_BASE_URL",
    group: "storage",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "Public base URL (for example a CDN) for objects that are safe to serve publicly, such as template thumbnails. When unset, every read uses a short-lived signed URL.",
    example: "https://cdn.example.org",
  },
  // Mail
  {
    name: "MAIL_TRANSPORT",
    group: "mail",
    targets: ["convex"],
    required: "yes",
    defaultValue: "log",
    secret: false,
    description:
      "`ses` (Amazon SES through the AWS credentials above), `smtp` (any SMTP server via `SMTP_URL`) or `log`. With `log` — also used when the value is unset or unknown — messages are written to the function logs instead of being sent, so nobody can confirm their email. Use it only for local development.",
    example: "smtp",
  },
  {
    name: "SES_FROM",
    group: "mail",
    targets: ["convex"],
    required: "yes",
    defaultValue: "Desyn <hello@desyn.app>",
    secret: false,
    description:
      "Sender of every outgoing message, for both transports, as `Name <address>`. The address must be verified in SES, or accepted by your SMTP server. `MAIL_FROM` is accepted as an alias and wins when both are set.",
    example: "Desyn <design@example.org>",
  },
  {
    name: "SMTP_URL",
    group: "mail",
    targets: ["convex"],
    required: "conditional",
    requiredWhen: "MAIL_TRANSPORT=smtp",
    secret: true,
    description:
      "Connection URL for the SMTP transport. Use `smtps://` for implicit TLS (port 465) or `smtp://` for STARTTLS (port 587). Percent-encode special characters in the password.",
    example: "smtps://user:password@smtp.example.org:465",
  },
  {
    name: "SES_CONFIGURATION_SET",
    group: "mail",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "Name of an SES configuration set to send with, for delivery, bounce and complaint tracking in AWS.",
  },
  // AI
  {
    name: "OPENROUTER_API_KEY",
    group: "ai",
    targets: ["convex"],
    required: "no",
    secret: true,
    description:
      "Server key for text and vision models through OpenRouter. Claude tasks fall back to it when `ANTHROPIC_API_KEY` is not set or the Anthropic API is unavailable; members can also pick any OpenRouter model per task.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    group: "ai",
    targets: ["convex"],
    required: "no",
    secret: true,
    description:
      "Server key for Claude on the Anthropic API: the default route for the agent, planning, critique, vision, SVG, copy and translation (Claude Sonnet, Opus and Haiku 5.5). Without it those tasks use OpenRouter.",
  },
  {
    name: "OPENAI_API_KEY",
    group: "ai",
    targets: ["convex"],
    required: "no",
    secret: true,
    description:
      "Optional server key for OpenAI models on the OpenAI API. When set, members can pick OpenAI models per task in Settings → AI, billed to platform credits.",
  },
  {
    name: "GOOGLE_GENERATIVE_AI_API_KEY",
    group: "ai",
    targets: ["convex"],
    required: "no",
    secret: true,
    description:
      "Optional server key for Gemini models on the Google Generative AI API. When set, members can pick Gemini models per task in Settings → AI, billed to platform credits.",
  },
  {
    name: "FAL_AI_API_KEY",
    group: "ai",
    targets: ["convex"],
    required: "no",
    secret: true,
    description:
      "Server key for media models on Fal: image generation, background removal, inpaint, outpaint, upscale and video. `FAL_KEY` is accepted as an alias.",
  },
  {
    name: "OLLAMA_BASE_URL",
    group: "ai",
    targets: ["convex", "web"],
    required: "no",
    secret: false,
    description:
      "Default base URL offered for the Ollama provider. Members can override it in Settings → AI providers.",
    example: "http://ollama:11434",
  },
  // Worker
  {
    name: "RENDER_WORKER_URL",
    group: "worker",
    targets: ["convex"],
    required: "yes",
    secret: false,
    description:
      "Internal URL of the render worker. Convex actions call it for exports, thumbnails, layout and the previews the agent looks at. Do not expose the worker publicly.",
    example: "http://worker:8080",
  },
  {
    name: "RENDER_WORKER_SECRET",
    group: "worker",
    targets: ["convex", "worker"],
    required: "yes",
    secret: true,
    description:
      "Shared secret sent in the `x-desyn-secret` header. Set the same value on Convex and on the worker.",
  },
  {
    name: "FONTS_DIR",
    group: "worker",
    targets: ["worker"],
    required: "no",
    defaultValue: "bundled OFL font set",
    secret: false,
    description:
      "Directory of font files the worker loads at start. Design-specific and custom fonts are fetched per request from asset URLs.",
    example: "/usr/share/desyn/fonts",
  },
  // Auth
  {
    name: "GOOGLE_CLIENT_ID",
    group: "auth",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "OAuth client id for Sign in with Google. Register `APP_URL/api/auth/callback/google` as the authorized redirect URI.",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    group: "auth",
    targets: ["convex"],
    required: "conditional",
    requiredWhen: "GOOGLE_CLIENT_ID is set",
    secret: true,
    description: "OAuth client secret for Sign in with Google.",
  },
  {
    name: "GITHUB_CLIENT_ID",
    group: "auth",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "OAuth app client id for Sign in with GitHub. Set the authorization callback URL to `APP_URL/api/auth/callback/github`.",
  },
  {
    name: "GITHUB_CLIENT_SECRET",
    group: "auth",
    targets: ["convex"],
    required: "conditional",
    requiredWhen: "GITHUB_CLIENT_ID is set",
    secret: true,
    description: "OAuth app client secret for Sign in with GitHub.",
  },
  {
    name: "APPLE_*",
    group: "auth",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "Reserved for Sign in with Apple. Apple sign-in is not available yet, so leave these unset; the desktop and iOS apps sign in through the browser with email, magic link, Google or GitHub.",
  },
  {
    name: "NATIVE_REDIRECT_URIS",
    group: "auth",
    targets: ["convex"],
    required: "no",
    secret: false,
    description:
      "Extra redirect URIs, comma-separated, allowed for the desktop, iOS and CLI sign-in flow. `desyn://auth/callback` and loopback addresses are always allowed.",
  },
  // Billing
  {
    name: "STRIPE_SECRET_KEY",
    group: "billing",
    targets: ["convex"],
    required: "conditional",
    requiredWhen: "DESYN_EDITION=hosted",
    secret: true,
    description: "Stripe API key for Checkout, the Customer Portal and subscription status.",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    group: "billing",
    targets: ["convex"],
    required: "conditional",
    requiredWhen: "DESYN_EDITION=hosted",
    secret: true,
    description: "Signing secret of the webhook endpoint at `CONVEX_SITE_URL/stripe/webhook`.",
  },
  {
    name: "STRIPE_PRICE_PRO_MONTHLY",
    group: "billing",
    targets: ["convex"],
    required: "conditional",
    requiredWhen: "DESYN_EDITION=hosted",
    secret: false,
    description: "Stripe price id of the monthly Pro plan.",
  },
  {
    name: "STRIPE_PRICE_PRO_YEARLY",
    group: "billing",
    targets: ["convex"],
    required: "conditional",
    requiredWhen: "DESYN_EDITION=hosted",
    secret: false,
    description: "Stripe price id of the yearly Pro plan.",
  },
  // Stock
  {
    name: "UNSPLASH_ACCESS_KEY",
    group: "stock",
    targets: ["convex"],
    required: "no",
    secret: true,
    description: "Enables Unsplash search. Attribution is stored with every photo you place.",
  },
  {
    name: "PEXELS_API_KEY",
    group: "stock",
    targets: ["convex"],
    required: "no",
    secret: true,
    description: "Enables Pexels search. Attribution is stored with every photo you place.",
  },
  // Telemetry
  {
    name: "NEXT_PUBLIC_POSTHOG_KEY",
    group: "telemetry",
    targets: ["web"],
    required: "no",
    secret: false,
    description:
      "PostHog project key for product analytics in the browser. Analytics stay off when unset.",
  },
  {
    name: "NEXT_PUBLIC_POSTHOG_HOST",
    group: "telemetry",
    targets: ["web"],
    required: "no",
    defaultValue: "https://eu.i.posthog.com",
    secret: false,
    description: "PostHog ingestion host. Defaults to the EU region.",
  },
  {
    name: "POSTHOG_PROJECT_API_KEY",
    group: "telemetry",
    targets: ["convex"],
    required: "no",
    secret: true,
    description: "PostHog key for server-side events (for example completed exports and AI runs).",
  },
  {
    name: "POSTHOG_HOST",
    group: "telemetry",
    targets: ["convex"],
    required: "no",
    defaultValue: "https://eu.i.posthog.com",
    secret: false,
    description: "PostHog host for server-side events. Falls back to `NEXT_PUBLIC_POSTHOG_HOST`.",
  },
  {
    name: "NEXT_PUBLIC_DATAFAST_WEBSITE_ID",
    group: "telemetry",
    targets: ["web"],
    required: "no",
    secret: false,
    description: "DataFast website id for privacy-friendly traffic analytics.",
  },
  {
    name: "NEXT_PUBLIC_DATAFAST_DOMAIN",
    group: "telemetry",
    targets: ["web"],
    required: "no",
    secret: false,
    description: "Domain registered with DataFast for this installation.",
  },
  {
    name: "DATAFAST_API_KEY",
    group: "telemetry",
    targets: ["convex"],
    required: "no",
    secret: true,
    description: "DataFast API key for server-side goal tracking.",
  },
  {
    name: "AXIOM_TOKEN",
    group: "telemetry",
    targets: ["convex", "web", "worker"],
    required: "no",
    secret: true,
    description:
      "Axiom ingest token. When set together with `AXIOM_DATASET`, structured logs are shipped to Axiom; otherwise they stay in local logs.",
  },
  {
    name: "AXIOM_DATASET",
    group: "telemetry",
    targets: ["convex", "web", "worker"],
    required: "conditional",
    requiredWhen: "AXIOM_TOKEN is set",
    secret: false,
    description:
      "Axiom dataset that receives logs. Logs are shipped only when both `AXIOM_TOKEN` and `AXIOM_DATASET` are set.",
    example: "desyn",
  },
  {
    name: "AXIOM_ORG_ID",
    group: "telemetry",
    targets: ["convex", "web", "worker"],
    required: "no",
    secret: false,
    description: "Axiom organization id (needed for personal tokens).",
  },
  {
    name: "AXIOM_URL",
    group: "telemetry",
    targets: ["convex"],
    required: "no",
    defaultValue: "https://api.axiom.co",
    secret: false,
    description: "Axiom API endpoint, for example a regional endpoint.",
  },
  {
    name: "LOG_LEVEL",
    group: "telemetry",
    targets: ["convex"],
    required: "no",
    defaultValue: "info",
    secret: false,
    description: "Minimum level of backend logs: `debug`, `info`, `warn` or `error`.",
  },
];

export function envAnchor(name: string): string {
  return `env-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "")}`;
}
