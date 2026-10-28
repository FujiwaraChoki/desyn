// DataFast revenue attribution for Stripe Checkout (added by the web agent). The web app reads the
// DataFast visitor/session cookies and passes them to `billing.stripeActions.createCheckout`; they are
// stored as Checkout Session metadata under the names DataFast looks for. Values are opaque ids from a
// first-party cookie, so anything outside a conservative shape is dropped instead of forwarded.

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface CheckoutAttribution {
  datafastVisitorId?: string;
  datafastSessionId?: string;
}

/** Stripe metadata entries for the attribution ids that are present and well-formed. */
export function attributionMetadata(
  attribution: CheckoutAttribution | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (attribution?.datafastVisitorId && ID.test(attribution.datafastVisitorId)) {
    out.datafast_visitor_id = attribution.datafastVisitorId;
  }
  if (attribution?.datafastSessionId && ID.test(attribution.datafastSessionId)) {
    out.datafast_session_id = attribution.datafastSessionId;
  }
  return out;
}
