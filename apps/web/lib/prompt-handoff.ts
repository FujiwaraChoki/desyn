/*
 * "Describe a design" hands its prompt to the editor through the URL (`/design/<id>?prompt=…`), so a
 * reload or a shared address keeps the text. A URL alone must never *run* the agent, though: anyone
 * could send a signed-in user a crafted `?prompt=` link that spends their credits or rewrites their
 * design. The dashboard therefore also leaves a one-time marker in this tab's sessionStorage; the
 * editor route sends the prompt automatically only when the marker matches, and otherwise just
 * prefills the AI dock for the user to review.
 */

const PREFIX = "desyn-autostart:";

/** Minimal storage surface (sessionStorage in the browser, a Map-backed fake in tests). */
export interface HandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): HandoffStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Called by the dashboard right before it opens the editor with `?prompt=`. */
export function markPromptForAutostart(
  designId: string,
  prompt: string,
  storage: HandoffStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(PREFIX + designId, prompt);
  } catch {
    // Storage blocked: the editor then prefills the prompt without sending it.
  }
}

/**
 * True once when `prompt` for `designId` was handed over by this tab's dashboard. The marker is
 * removed on read, so reloading the editor never starts the same run twice.
 */
export function consumePromptAutostart(
  designId: string,
  prompt: string | undefined,
  storage: HandoffStorage | null = browserStorage(),
): boolean {
  if (!storage || !prompt) return false;
  try {
    const marked = storage.getItem(PREFIX + designId);
    if (marked === null) return false;
    storage.removeItem(PREFIX + designId);
    return marked === prompt;
  } catch {
    return false;
  }
}
