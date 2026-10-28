import type { SubscriptionStatus } from "../lib/validators";

// Turn raw Stripe JSON (webhook payloads or API objects) into the small shapes we store. Handles both
// legacy (`current_period_end` on the subscription, `invoice.subscription`) and current API layouts
// (periods on subscription items, `invoice.parent.subscription_details.subscription`).

export interface NormalizedSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId?: string;
  interval?: "month" | "year";
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
  canceledAt?: number;
  userId?: string;
}

export interface NormalizedInvoice {
  id: string;
  customerId: string;
  subscriptionId?: string;
  amountPaid: number;
  amountDue: number;
  currency: string;
  hostedInvoiceUrl?: string;
  attemptCount: number;
  periodEnd?: number;
  priceId?: string;
  interval?: "month" | "year";
  billingReason?: string;
}

type Json = Record<string, unknown>;

const STATUSES: SubscriptionStatus[] = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
];

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Stripe ids may arrive expanded (object with id) or as plain strings. */
function idOf(value: unknown): string | undefined {
  return str(value) ?? str(obj(value)?.id);
}

function ms(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000;
}

function firstItem(sub: Json): Json | undefined {
  const items = obj(sub.items);
  const data = items?.data;
  return Array.isArray(data) ? obj(data[0]) : undefined;
}

function intervalOf(price: Json | undefined): "month" | "year" | undefined {
  const interval = obj(price?.recurring)?.interval;
  return interval === "month" || interval === "year" ? interval : undefined;
}

export function normalizeSubscription(raw: unknown): NormalizedSubscription | null {
  const sub = obj(raw);
  const id = str(sub?.id);
  const customerId = idOf(sub?.customer);
  const status = sub?.status;
  if (!sub || !id || !customerId || typeof status !== "string") return null;
  if (!STATUSES.includes(status as SubscriptionStatus)) return null;
  const item = firstItem(sub);
  const price = obj(item?.price);
  const periodStart = num(item?.current_period_start) ?? num(sub.current_period_start);
  const periodEnd = num(item?.current_period_end) ?? num(sub.current_period_end);
  const canceledAt = num(sub.canceled_at);
  const userId = str(obj(sub.metadata)?.userId);
  const priceId = str(price?.id);
  const interval = intervalOf(price);
  return {
    id,
    customerId,
    status: status as SubscriptionStatus,
    ...(priceId ? { priceId } : {}),
    ...(interval ? { interval } : {}),
    ...(periodStart !== undefined ? { currentPeriodStart: ms(periodStart) } : {}),
    ...(periodEnd !== undefined ? { currentPeriodEnd: ms(periodEnd) } : {}),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || num(sub.cancel_at) !== undefined,
    ...(canceledAt !== undefined ? { canceledAt: ms(canceledAt) } : {}),
    ...(userId ? { userId } : {}),
  };
}

export function normalizeInvoice(raw: unknown): NormalizedInvoice | null {
  const inv = obj(raw);
  const id = str(inv?.id);
  const customerId = idOf(inv?.customer);
  if (!inv || !id || !customerId) return null;
  const parent = obj(inv.parent);
  const subscriptionId =
    idOf(obj(parent?.subscription_details)?.subscription) ?? idOf(inv.subscription);
  const lines = obj(inv.lines)?.data;
  const firstLine = Array.isArray(lines) ? obj(lines[0]) : undefined;
  const linePrice =
    obj(firstLine?.price) ?? obj(obj(obj(firstLine?.pricing)?.price_details)?.price);
  const periodEnd = num(obj(firstLine?.period)?.end) ?? num(inv.period_end);
  const priceId = idOf(linePrice) ?? str(obj(obj(firstLine?.pricing)?.price_details)?.price);
  const interval = intervalOf(linePrice);
  const hostedInvoiceUrl = str(inv.hosted_invoice_url);
  const billingReason = str(inv.billing_reason);
  return {
    id,
    customerId,
    ...(subscriptionId ? { subscriptionId } : {}),
    amountPaid: num(inv.amount_paid) ?? 0,
    amountDue: num(inv.amount_due) ?? 0,
    currency: str(inv.currency) ?? "usd",
    ...(hostedInvoiceUrl ? { hostedInvoiceUrl } : {}),
    attemptCount: num(inv.attempt_count) ?? 0,
    ...(periodEnd !== undefined ? { periodEnd: periodEnd * 1000 } : {}),
    ...(priceId ? { priceId } : {}),
    ...(interval ? { interval } : {}),
    ...(billingReason ? { billingReason } : {}),
  };
}

/** Subscription states that grant Pro. past_due keeps access while Stripe retries the payment. */
export function grantsPro(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}
