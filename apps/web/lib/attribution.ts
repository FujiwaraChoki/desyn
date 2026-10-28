/*
 * DataFast revenue attribution: the DataFast script stores the visitor and session ids in first-party
 * cookies; passing them as Stripe Checkout metadata lets DataFast attribute revenue to traffic sources.
 * The cookies only exist after the visitor allowed analytics (the script is not loaded before).
 */

export const DATAFAST_VISITOR_COOKIE = "datafast_visitor_id";
export const DATAFAST_SESSION_COOKIE = "datafast_session_id";

/** Ids are opaque tokens; anything outside this shape is ignored rather than forwarded. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface DatafastAttribution {
  datafastVisitorId?: string;
  datafastSessionId?: string;
}

export function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function datafastAttribution(cookieHeader: string): DatafastAttribution | undefined {
  const visitor = readCookie(cookieHeader, DATAFAST_VISITOR_COOKIE);
  const session = readCookie(cookieHeader, DATAFAST_SESSION_COOKIE);
  const out: DatafastAttribution = {};
  if (visitor && ID_PATTERN.test(visitor)) out.datafastVisitorId = visitor;
  if (session && ID_PATTERN.test(session)) out.datafastSessionId = session;
  return out.datafastVisitorId || out.datafastSessionId ? out : undefined;
}
