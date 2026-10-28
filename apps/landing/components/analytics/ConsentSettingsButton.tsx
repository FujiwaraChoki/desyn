"use client";

import { CONSENT_RESET_EVENT } from "./Analytics";

/** Lets visitors change their analytics choice at any time (re-opens the consent banner). */
export function ConsentSettingsButton() {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={() => window.dispatchEvent(new CustomEvent(CONSENT_RESET_EVENT))}
    >
      Change my cookie choice
    </button>
  );
}
