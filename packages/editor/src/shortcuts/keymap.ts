import { formatShortcut, matchesShortcut, type Platform, parseShortcut } from "@desyn/ui";
import type { CommandRegistry } from "../commands/registry.ts";
import { DEFAULT_KEYMAP } from "./defaults.ts";

/**
 * Effective key bindings = user overrides (profile prefs) over the defaults table over command-provided
 * `keys`. Matching extends @desyn/ui's `matchesShortcut` with a physical-key fallback for shifted digits and
 * punctuation (`shift+0` arrives as ")" on US layouts, `mod+shift+'` as '"').
 */

export type KeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

const CODE_KEYS: Record<string, string> = {
  Quote: "'",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Equal: "=",
  Minus: "-",
  Semicolon: ";",
  Backquote: "`",
};

/** The unshifted key a physical key produces on a US layout (`Digit0` -> "0", `KeyA` -> "a"). */
export function baseKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_KEYS[code] ?? null;
}

export function matchKey(event: KeyEvent, combo: string, platform: Platform): boolean {
  if (matchesShortcut(event, combo, platform)) return true;
  const s = parseShortcut(combo);
  // Shifted digits / punctuation: compare the physical key and require exactly the declared modifiers.
  if (!s.shift || !event.shiftKey) return false;
  const base = baseKeyFromCode(event.code);
  if (!base || base !== s.key || /^[a-z]$/.test(base)) return false;
  const wantMeta = s.meta || (s.mod && platform === "mac");
  const wantCtrl = s.ctrl || (s.mod && platform !== "mac");
  return event.metaKey === wantMeta && event.ctrlKey === wantCtrl && event.altKey === s.alt;
}

/** Bindings of every registered command, overrides applied. */
export function effectiveKeymap(
  registry: CommandRegistry,
  overrides: Readonly<Record<string, readonly string[]>>,
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const cmd of registry.all()) {
    const keys = overrides[cmd.id] ?? DEFAULT_KEYMAP[cmd.id] ?? cmd.keys ?? [];
    if (keys.length > 0) map.set(cmd.id, keys);
  }
  return map;
}

/** Keys for one command (display). */
export function keysFor(
  id: string,
  overrides: Readonly<Record<string, readonly string[]>>,
  fallback?: readonly string[],
): readonly string[] {
  return overrides[id] ?? DEFAULT_KEYMAP[id] ?? fallback ?? [];
}

/** Canonical form for comparing combos ("shift+mod+K" == "mod+shift+k"). */
export function normalizeCombo(combo: string): string {
  const s = parseShortcut(combo);
  const parts: string[] = [];
  if (s.mod) parts.push("mod");
  if (s.ctrl) parts.push("ctrl");
  if (s.meta) parts.push("meta");
  if (s.alt) parts.push("alt");
  if (s.shift) parts.push("shift");
  parts.push(s.key === "+" ? "plus" : s.key === " " ? "space" : s.key);
  return parts.join("+");
}

/** Commands sharing a combo (for the shortcut editor). */
export function findConflicts(keymap: Map<string, readonly string[]>): Map<string, string[]> {
  const byCombo = new Map<string, string[]>();
  for (const [id, keys] of keymap) {
    for (const k of keys) {
      const n = normalizeCombo(k);
      byCombo.set(n, [...(byCombo.get(n) ?? []), id]);
    }
  }
  return new Map([...byCombo].filter(([, ids]) => ids.length > 1));
}

/** Records a combo from a key event (shortcut editor). Null for lone modifiers. */
export function comboFromEvent(event: KeyEvent, platform: Platform): string | null {
  const key = event.key.toLowerCase();
  if (["shift", "control", "alt", "meta", "os", "capslock", "dead"].includes(key)) return null;
  const base = baseKeyFromCode(event.code);
  let name =
    base ??
    (key === " "
      ? "space"
      : key === "+"
        ? "plus"
        : key.length === 1
          ? key
          : key.replace(/\s+/g, ""));
  if (name === "+") name = "plus";
  const parts: string[] = [];
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  if (mod) parts.push("mod");
  if (platform === "mac" && event.ctrlKey) parts.push("ctrl");
  if (platform !== "mac" && event.metaKey) parts.push("meta");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(name);
  return parts.join("+");
}

/** Display string for a combo: `⇧⌘K` on macOS, `Ctrl+Shift+K` elsewhere. */
export function formatCombo(combo: string, platform: Platform): string {
  if (combo === "space") return "Space";
  return formatShortcut(combo, platform);
}
