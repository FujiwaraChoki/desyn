// Idempotently creates the Stripe objects Desyn's hosted edition needs:
//   - the "Desyn Pro" product,
//   - its monthly ($8) and yearly ($80) prices (amounts from config/plans.json),
//   - a webhook endpoint at <base-url>/stripe/webhook for the events Convex handles.
//
// Usage (reads STRIPE_SECRET_KEY from the environment; prints only object ids, never keys):
//   node scripts/stripe-bootstrap.ts --base-url https://api.desyn.app [--convex-env [--convex-prod]]
//                                    [--env-file deploy/.stripe.env] [--dry-run]
//
// The webhook signing secret is only returned by Stripe when the endpoint is created. It is written
// to Convex (`--convex-env`, piped through stdin) and/or a 0600 env file (`--env-file`); without a
// destination the script refuses to create a new endpoint.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

export const PRODUCT_KEY = "desyn-pro";
export const MONTHLY_LOOKUP = "desyn_pro_monthly";
export const YEARLY_LOOKUP = "desyn_pro_yearly";
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

/** The subset of the Stripe client the bootstrap uses (lets tests pass a fake). */
export interface StripeLike {
  products: {
    list(params: { limit: number; active?: boolean; starting_after?: string }): Promise<{
      data: { id: string; metadata: Record<string, string> | null; active: boolean }[];
      has_more: boolean;
    }>;
    create(
      params: Stripe.ProductCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string }>;
  };
  prices: {
    list(params: { lookup_keys: string[]; active?: boolean; limit?: number }): Promise<{
      data: {
        id: string;
        lookup_key: string | null;
        unit_amount: number | null;
        currency: string;
        product: string | { id: string };
        recurring: { interval: string } | null;
      }[];
    }>;
    create(
      params: Stripe.PriceCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string }>;
  };
  webhookEndpoints: {
    list(params: { limit: number; starting_after?: string }): Promise<{
      data: { id: string; url: string; enabled_events: string[]; status: string }[];
      has_more: boolean;
    }>;
    create(params: Stripe.WebhookEndpointCreateParams): Promise<{ id: string; secret?: string }>;
    update(id: string, params: Stripe.WebhookEndpointUpdateParams): Promise<{ id: string }>;
  };
}

export interface BootstrapOptions {
  baseUrl: string;
  monthlyCents: number;
  yearlyCents: number;
  dryRun?: boolean;
  /** Whether a new webhook secret can be stored somewhere; required to create an endpoint. */
  canStoreSecret: boolean;
  log?: (line: string) => void;
}

export interface BootstrapResult {
  productId: string;
  monthlyPriceId: string;
  yearlyPriceId: string;
  webhookEndpointId: string;
  /** Present only when the endpoint was created in this run. */
  webhookSecret?: string;
  created: string[];
}

function productIdOf(product: string | { id: string }): string {
  return typeof product === "string" ? product : product.id;
}

async function findProduct(stripe: StripeLike): Promise<string | null> {
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.products.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = page.data.find((p) => p.metadata?.desyn_key === PRODUCT_KEY && p.active);
    if (match) return match.id;
    if (!page.has_more || page.data.length === 0) return null;
    startingAfter = page.data.at(-1)?.id;
  }
}

async function findWebhook(stripe: StripeLike, url: string) {
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.webhookEndpoints.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = page.data.find((w) => w.url === url);
    if (match) return match;
    if (!page.has_more || page.data.length === 0) return null;
    startingAfter = page.data.at(-1)?.id;
  }
}

export async function bootstrap(
  stripe: StripeLike,
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const log = opts.log ?? (() => {});
  const created: string[] = [];
  const base = opts.baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("--base-url must be an absolute http(s) URL");
  const webhookUrl = `${base}/stripe/webhook`;

  // 1. Product
  let productId = await findProduct(stripe);
  if (productId) {
    log(`product      ${productId} (existing)`);
  } else if (opts.dryRun) {
    productId = "(would create)";
    log("product      would create Desyn Pro");
  } else {
    const product = await stripe.products.create(
      {
        name: "Desyn Pro",
        description: "Every Desyn feature, the AI studio and a monthly credit pool, with fair use.",
        metadata: { desyn_key: PRODUCT_KEY },
      },
      { idempotencyKey: `desyn-bootstrap-product-${PRODUCT_KEY}` },
    );
    productId = product.id;
    created.push("product");
    log(`product      ${productId} (created)`);
  }

  // 2. Prices (looked up by lookup_key; a changed amount creates a new price that takes the key over)
  const existing = await stripe.prices.list({
    lookup_keys: [MONTHLY_LOOKUP, YEARLY_LOOKUP],
    active: true,
    limit: 10,
  });
  const ensurePrice = async (lookupKey: string, cents: number, interval: "month" | "year") => {
    const match = existing.data.find(
      (p) =>
        p.lookup_key === lookupKey &&
        p.unit_amount === cents &&
        p.currency === "usd" &&
        p.recurring?.interval === interval &&
        productIdOf(p.product) === productId,
    );
    if (match) {
      log(`price ${interval.padEnd(6)} ${match.id} (existing)`);
      return match.id;
    }
    if (opts.dryRun) {
      log(`price ${interval.padEnd(6)} would create ${cents / 100} USD / ${interval}`);
      return "(would create)";
    }
    const price = await stripe.prices.create(
      {
        product: productId as string,
        currency: "usd",
        unit_amount: cents,
        recurring: { interval },
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        nickname: `Desyn Pro ${interval === "month" ? "monthly" : "yearly"}`,
        metadata: { desyn_key: lookupKey },
      },
      { idempotencyKey: `desyn-bootstrap-${lookupKey}-${cents}-${productId}` },
    );
    created.push(`price:${interval}`);
    log(`price ${interval.padEnd(6)} ${price.id} (created)`);
    return price.id;
  };
  const monthlyPriceId = await ensurePrice(MONTHLY_LOOKUP, opts.monthlyCents, "month");
  const yearlyPriceId = await ensurePrice(YEARLY_LOOKUP, opts.yearlyCents, "year");

  // 3. Webhook endpoint
  const events = [...WEBHOOK_EVENTS] as Stripe.WebhookEndpointCreateParams.EnabledEvent[];
  const hook = await findWebhook(stripe, webhookUrl);
  let webhookEndpointId: string;
  let webhookSecret: string | undefined;
  if (hook) {
    webhookEndpointId = hook.id;
    const missing = WEBHOOK_EVENTS.some(
      (e) => !hook.enabled_events.includes(e) && !hook.enabled_events.includes("*"),
    );
    if ((missing || hook.status !== "enabled") && !opts.dryRun) {
      await stripe.webhookEndpoints.update(hook.id, { enabled_events: events, disabled: false });
      log(`webhook      ${hook.id} (updated events)`);
    } else {
      log(`webhook      ${hook.id} (existing)`);
    }
  } else if (opts.dryRun) {
    webhookEndpointId = "(would create)";
    log(`webhook      would create ${webhookUrl}`);
  } else {
    if (!opts.canStoreSecret) {
      throw new Error(
        "Creating the webhook endpoint returns its signing secret once. Pass --convex-env and/or --env-file so it can be stored.",
      );
    }
    const endpoint = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: events,
      description: "Desyn (Convex) billing webhook",
      metadata: { desyn_key: "desyn-webhook" },
    });
    webhookEndpointId = endpoint.id;
    webhookSecret = endpoint.secret;
    created.push("webhook");
    log(`webhook      ${endpoint.id} (created)`);
  }

  return {
    productId: productId as string,
    monthlyPriceId,
    yearlyPriceId,
    webhookEndpointId,
    ...(webhookSecret ? { webhookSecret } : {}),
    created,
  };
}

/** Insert or replace NAME=value lines in an env file, keeping other lines; file mode 0600. */
export function upsertEnvFile(path: string, values: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const name = line.split("=", 1)[0]?.trim();
    if (name && pending.has(name)) {
      const value = pending.get(name) as string;
      pending.delete(name);
      return `${name}=${value}`;
    }
    return line;
  });
  while (out.length > 0 && out.at(-1) === "") out.pop();
  for (const [name, value] of pending) out.push(`${name}=${value}`);
  writeFileSync(path, `${out.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function setConvexEnv(name: string, value: string, prod: boolean): void {
  const args = ["convex", "env", "set", name, ...(prod ? ["--prod"] : [])];
  const result = spawnSync("npx", args, { input: value, stdio: ["pipe", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error(`npx convex env set ${name} failed`);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = typeof args["base-url"] === "string" ? args["base-url"] : undefined;
  if (!baseUrl) {
    console.error(
      "Usage: node scripts/stripe-bootstrap.ts --base-url <convex site url> [--convex-env] [--env-file <path>] [--dry-run]",
    );
    process.exit(2);
  }
  const { STRIPE_SECRET_KEY: key } = process.env;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set in the environment.");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const plans = JSON.parse(readFileSync(resolve(root, "config/plans.json"), "utf8")) as {
    plans: { pro: { priceMonthly: number; priceYearly: number } };
  };
  const envFile = typeof args["env-file"] === "string" ? resolve(args["env-file"]) : undefined;
  const toConvex = args["convex-env"] === true;
  const stripe = new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: "Desyn bootstrap" } });
  const result = await bootstrap(stripe as unknown as StripeLike, {
    baseUrl,
    monthlyCents: Math.round(plans.plans.pro.priceMonthly * 100),
    yearlyCents: Math.round(plans.plans.pro.priceYearly * 100),
    dryRun: args["dry-run"] === true,
    canStoreSecret: toConvex || Boolean(envFile),
    log: (line) => console.log(line),
  });
  if (args["dry-run"] === true) return;
  const values: Record<string, string> = {
    STRIPE_PRICE_PRO_MONTHLY: result.monthlyPriceId,
    STRIPE_PRICE_PRO_YEARLY: result.yearlyPriceId,
    ...(result.webhookSecret ? { STRIPE_WEBHOOK_SECRET: result.webhookSecret } : {}),
  };
  if (envFile) {
    upsertEnvFile(envFile, values);
    console.log(`wrote ${Object.keys(values).join(", ")} to ${envFile}`);
  }
  if (toConvex) {
    for (const [name, value] of Object.entries(values))
      setConvexEnv(name, value, args["convex-prod"] === true);
    console.log(`set ${Object.keys(values).join(", ")} on the Convex deployment`);
  }
  if (!envFile && !toConvex) {
    console.log(`STRIPE_PRICE_PRO_MONTHLY=${result.monthlyPriceId}`);
    console.log(`STRIPE_PRICE_PRO_YEARLY=${result.yearlyPriceId}`);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // Stripe errors never include the API key; print only the message.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
