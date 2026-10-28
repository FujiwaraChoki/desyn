"use client";

/*
 * Password-protected share links are unlocked once with `designs.unlockShare`, which returns a short-lived grant
 * (`sg_...`). The grant, never the password, is kept for the browser session (sessionStorage, per token) and passed
 * as `share: { token, password: grant }`, so the share page, the presenter and the editor open the link without the
 * password reaching a URL, storage or any function other than the rate-limited unlock.
 */

const PREFIX = "desyn-share-grant:";

export function rememberShareGrant(token: string, grant: string): void {
  try {
    sessionStorage.setItem(PREFIX + token, grant);
  } catch {
    // Storage blocked: the user unlocks the link again on the next page.
  }
}

export function forgetShareGrant(token: string): void {
  try {
    sessionStorage.removeItem(PREFIX + token);
  } catch {
    // Nothing stored.
  }
}

export function shareGrant(token: string): string | undefined {
  try {
    return sessionStorage.getItem(PREFIX + token) ?? undefined;
  } catch {
    return undefined;
  }
}

export function shareArg(
  token: string | null | undefined,
): { token: string; password?: string } | undefined {
  if (!token) return undefined;
  const grant = shareGrant(token);
  return grant ? { token, password: grant } : { token };
}
