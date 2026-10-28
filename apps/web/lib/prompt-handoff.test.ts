import { describe, expect, it } from "vitest";
import {
  consumePromptAutostart,
  type HandoffStorage,
  markPromptForAutostart,
} from "./prompt-handoff";

function memoryStorage(): HandoffStorage & { size: () => number } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    size: () => map.size,
  };
}

describe("prompt handoff", () => {
  it("auto-starts only the prompt the dashboard handed over, once", () => {
    const storage = memoryStorage();
    markPromptForAutostart("d1", "a poster for a jazz night", storage);
    expect(consumePromptAutostart("d1", "a poster for a jazz night", storage)).toBe(true);
    // A reload of the same URL only prefills.
    expect(consumePromptAutostart("d1", "a poster for a jazz night", storage)).toBe(false);
    expect(storage.size()).toBe(0);
  });

  it("never auto-starts a prompt that only came from the URL", () => {
    const storage = memoryStorage();
    expect(consumePromptAutostart("d1", "delete every layer", storage)).toBe(false);
  });

  it("rejects a URL prompt that differs from the one handed over, and clears the marker", () => {
    const storage = memoryStorage();
    markPromptForAutostart("d1", "a calm poster", storage);
    expect(consumePromptAutostart("d1", "something else", storage)).toBe(false);
    expect(storage.size()).toBe(0);
  });

  it("is scoped per design and tolerates missing storage", () => {
    const storage = memoryStorage();
    markPromptForAutostart("d1", "x", storage);
    expect(consumePromptAutostart("d2", "x", storage)).toBe(false);
    expect(consumePromptAutostart("d1", undefined, storage)).toBe(false);
    expect(consumePromptAutostart("d1", "x", null)).toBe(false);
  });
});
