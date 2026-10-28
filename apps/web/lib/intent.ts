/*
 * What a visitor came for when they arrived from the marketing site (`/signup?plan=pro&interval=year`
 * or `/signup?template=<slug>`). Kept in localStorage across email verification, consumed once after
 * onboarding.
 */

export const INTENT_KEY = "desyn-intent";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface SignupIntent {
  plan?: "pro";
  interval?: "month" | "year";
  template?: string;
  at: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function intentFromParams(
  params: {
    plan?: string | undefined;
    interval?: string | undefined;
    template?: string | undefined;
  },
  now = Date.now(),
): SignupIntent | null {
  const intent: SignupIntent = { at: now };
  if (params.plan === "pro") intent.plan = "pro";
  if (params.interval === "month" || params.interval === "year") intent.interval = params.interval;
  if (params.template && SLUG.test(params.template)) intent.template = params.template;
  return intent.plan || intent.template ? intent : null;
}

export function parseIntent(raw: string | null, now = Date.now()): SignupIntent | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<SignupIntent>;
    if (typeof data.at !== "number" || now - data.at > MAX_AGE_MS) return null;
    return intentFromParams(
      { plan: data.plan, interval: data.interval, template: data.template },
      data.at,
    );
  } catch {
    return null;
  }
}

export function saveIntent(intent: SignupIntent | null): void {
  try {
    if (intent) localStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    // Storage blocked: the intent is a convenience only.
  }
}

export function readIntent(): SignupIntent | null {
  try {
    return parseIntent(localStorage.getItem(INTENT_KEY));
  } catch {
    return null;
  }
}

export function clearIntent(): void {
  try {
    localStorage.removeItem(INTENT_KEY);
  } catch {
    // ignore
  }
}
