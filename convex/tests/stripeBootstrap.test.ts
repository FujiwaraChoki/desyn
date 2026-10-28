// @vitest-environment node
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  bootstrap,
  type StripeLike,
  upsertEnvFile,
  WEBHOOK_EVENTS,
} from "../../scripts/stripe-bootstrap";

/** In-memory Stripe with just enough behavior for the bootstrap (lookup keys, idempotency, secrets). */
function fakeStripe() {
  let n = 0;
  const products: { id: string; metadata: Record<string, string>; active: boolean }[] = [];
  const prices: {
    id: string;
    lookup_key: string | null;
    unit_amount: number;
    currency: string;
    product: string;
    recurring: { interval: string };
    active: boolean;
  }[] = [];
  const hooks: {
    id: string;
    url: string;
    enabled_events: string[];
    status: string;
    secret: string;
  }[] = [];
  const calls: string[] = [];
  const stripe: StripeLike = {
    products: {
      list: async () => ({ data: products, has_more: false }),
      create: async (p) => {
        calls.push("products.create");
        const product = {
          id: `prod_${++n}`,
          metadata: (p.metadata ?? {}) as Record<string, string>,
          active: true,
        };
        products.push(product);
        return product;
      },
    },
    prices: {
      list: async ({ lookup_keys }) => ({
        data: prices.filter((p) => p.active && p.lookup_key && lookup_keys.includes(p.lookup_key)),
      }),
      create: async (p) => {
        calls.push("prices.create");
        if (p.transfer_lookup_key) {
          for (const old of prices) if (old.lookup_key === p.lookup_key) old.lookup_key = null;
        }
        const price = {
          id: `price_${++n}`,
          lookup_key: p.lookup_key ?? null,
          unit_amount: p.unit_amount as number,
          currency: p.currency,
          product: p.product as string,
          recurring: { interval: p.recurring?.interval as string },
          active: true,
        };
        prices.push(price);
        return price;
      },
    },
    webhookEndpoints: {
      list: async () => ({ data: hooks, has_more: false }),
      create: async (p) => {
        calls.push("webhookEndpoints.create");
        const hook = {
          id: `we_${++n}`,
          url: p.url,
          enabled_events: p.enabled_events as string[],
          status: "enabled",
          secret: `whsec_${n}`,
        };
        hooks.push(hook);
        return { id: hook.id, secret: hook.secret };
      },
      update: async (id, p) => {
        calls.push("webhookEndpoints.update");
        const hook = hooks.find((h) => h.id === id);
        if (hook && p.enabled_events) hook.enabled_events = p.enabled_events as string[];
        return { id };
      },
    },
  };
  return { stripe, calls, prices, hooks };
}

const opts = {
  baseUrl: "https://api.desyn.app/",
  monthlyCents: 800,
  yearlyCents: 8000,
  canStoreSecret: true,
};

describe("stripe bootstrap script", () => {
  test("creates product, prices and webhook once; re-runs are no-ops", async () => {
    const fake = fakeStripe();
    const first = await bootstrap(fake.stripe, opts);
    expect(first.created).toEqual(["product", "price:month", "price:year", "webhook"]);
    expect(first.webhookSecret).toMatch(/^whsec_/);
    expect(fake.hooks[0]?.url).toBe("https://api.desyn.app/stripe/webhook");
    expect(fake.hooks[0]?.enabled_events).toEqual([...WEBHOOK_EVENTS]);
    expect(fake.prices.map((p) => [p.lookup_key, p.unit_amount, p.recurring.interval])).toEqual([
      ["desyn_pro_monthly", 800, "month"],
      ["desyn_pro_yearly", 8000, "year"],
    ]);

    const second = await bootstrap(fake.stripe, opts);
    expect(second.created).toEqual([]);
    expect(second.webhookSecret).toBeUndefined();
    expect(second).toMatchObject({
      productId: first.productId,
      monthlyPriceId: first.monthlyPriceId,
      yearlyPriceId: first.yearlyPriceId,
      webhookEndpointId: first.webhookEndpointId,
    });
  });

  test("a changed price creates a new price that takes over the lookup key; missing events are added", async () => {
    const fake = fakeStripe();
    const first = await bootstrap(fake.stripe, opts);
    if (fake.hooks[0]) fake.hooks[0].enabled_events = ["invoice.paid"];
    const second = await bootstrap(fake.stripe, { ...opts, monthlyCents: 900 });
    expect(second.monthlyPriceId).not.toBe(first.monthlyPriceId);
    expect(second.yearlyPriceId).toBe(first.yearlyPriceId);
    expect(fake.prices.find((p) => p.id === first.monthlyPriceId)?.lookup_key).toBeNull();
    expect(fake.calls).toContain("webhookEndpoints.update");
    expect(fake.hooks[0]?.enabled_events).toEqual([...WEBHOOK_EVENTS]);
  });

  test("dry run changes nothing and webhook creation needs a secret destination", async () => {
    const fake = fakeStripe();
    const dry = await bootstrap(fake.stripe, { ...opts, dryRun: true });
    expect(dry.created).toEqual([]);
    expect(fake.calls).toEqual([]);
    await expect(bootstrap(fake.stripe, { ...opts, canStoreSecret: false })).rejects.toThrow(
      /--convex-env/,
    );
  });

  test("env file upsert keeps other lines and uses mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "desyn-stripe-"));
    const file = join(dir, "stripe.env");
    writeFileSync(file, "OTHER=1\nSTRIPE_PRICE_PRO_MONTHLY=old\n");
    upsertEnvFile(file, {
      STRIPE_PRICE_PRO_MONTHLY: "price_new",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    expect(readFileSync(file, "utf8")).toBe(
      "OTHER=1\nSTRIPE_PRICE_PRO_MONTHLY=price_new\nSTRIPE_WEBHOOK_SECRET=whsec_x\n",
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
