/**
 * Keyboard shortcut parsing, matching and per-OS formatting.
 * Shortcuts are written as `"mod+shift+k"`; `mod` is ⌘ on Apple platforms and Ctrl elsewhere.
 */

export type Platform = "mac" | "windows" | "linux";

/** Detects the platform from the user agent (falls back to `linux` outside the browser). */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const source = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/mac|iphone|ipad|ipod/i.test(source)) return "mac";
  if (/win/i.test(source)) return "windows";
  return "linux";
}

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** Lowercased key name (`k`, `enter`, `arrowup`, `/`, `[`). */
  key: string;
}

const ALIASES: Record<string, string> = {
  cmd: "meta",
  command: "meta",
  "⌘": "meta",
  option: "alt",
  opt: "alt",
  "⌥": "alt",
  control: "ctrl",
  "⌃": "ctrl",
  "⇧": "shift",
  esc: "escape",
  return: "enter",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  space: " ",
  plus: "+",
};

/** Parses `"mod+shift+k"`. A literal plus is written `"mod+plus"`. */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ALIASES[p] ?? p);
  const parsed: ParsedShortcut = {
    mod: false,
    ctrl: false,
    meta: false,
    shift: false,
    alt: false,
    key: "",
  };
  for (const part of parts) {
    if (part === "mod") parsed.mod = true;
    else if (part === "ctrl") parsed.ctrl = true;
    else if (part === "meta") parsed.meta = true;
    else if (part === "shift") parsed.shift = true;
    else if (part === "alt") parsed.alt = true;
    else parsed.key = part;
  }
  return parsed;
}

/**
 * Physical-key fallback so `alt+k` still matches on macOS where Option changes `event.key`, and
 * letter shortcuts work on non-Latin layouts.
 */
function codeKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return null;
}

/** True when a keyboard event matches the shortcut on the given platform. */
export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  shortcut: string | ParsedShortcut,
  platform: Platform = detectPlatform(),
): boolean {
  const s = typeof shortcut === "string" ? parseShortcut(shortcut) : shortcut;
  const wantMeta = s.meta || (s.mod && platform === "mac");
  const wantCtrl = s.ctrl || (s.mod && platform !== "mac");
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl || event.altKey !== s.alt)
    return false;
  const key = event.key.toLowerCase();
  // Fall back to the physical key only when the layout produced a non-ASCII character (Option
  // symbols on macOS, Cyrillic, Greek...). On Latin layouts such as Dvorak the typed key wins, so
  // ⌘T there never fires a `mod+k` binding just because T sits where QWERTY has K.
  const nonLatin = key === "dead" || (key.length === 1 && key.charCodeAt(0) > 0x7e);
  const matchesKey = key === s.key || (nonLatin && codeKey(event.code) === s.key);
  if (!matchesKey) return false;
  // Shift is implied by symbols like `?` or `+`; only enforce it for letters, digits and named keys.
  const shiftSensitive = /^[a-z0-9]$/.test(s.key) || s.key.length > 1;
  return shiftSensitive ? event.shiftKey === s.shift : !s.shift || event.shiftKey;
}

const MAC_SYMBOLS: Record<string, string> = {
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
  escape: "esc",
  tab: "⇥",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
  capslock: "⇪",
  pageup: "⇞",
  pagedown: "⇟",
  home: "↖",
  end: "↘",
};

const PC_NAMES: Record<string, string> = {
  meta: "Win",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Del",
  escape: "Esc",
  tab: "Tab",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
};

function keyLabel(key: string, platform: Platform): string {
  const table = platform === "mac" ? MAC_SYMBOLS : PC_NAMES;
  if (table[key]) return table[key];
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1);
}

/**
 * The individual key labels of a shortcut in platform order:
 * mac `["⌃", "⌥", "⇧", "⌘", "K"]`, others `["Ctrl", "Alt", "Shift", "K"]`.
 */
export function shortcutKeys(shortcut: string, platform: Platform = detectPlatform()): string[] {
  const s = parseShortcut(shortcut);
  const ctrl = s.ctrl || (s.mod && platform !== "mac");
  const meta = s.meta || (s.mod && platform === "mac");
  const order: [boolean, string][] =
    platform === "mac"
      ? [
          [ctrl, "ctrl"],
          [s.alt, "alt"],
          [s.shift, "shift"],
          [meta, "meta"],
        ]
      : [
          [ctrl, "ctrl"],
          [meta, "meta"],
          [s.alt, "alt"],
          [s.shift, "shift"],
        ];
  const keys = order.filter(([on]) => on).map(([, name]) => keyLabel(name, platform));
  if (s.key) keys.push(keyLabel(s.key, platform));
  return keys;
}

/** A shortcut as display text: `⇧⌘K` on mac, `Ctrl+Shift+K` elsewhere. */
export function formatShortcut(shortcut: string, platform: Platform = detectPlatform()): string {
  const keys = shortcutKeys(shortcut, platform);
  return platform === "mac" ? keys.join("") : keys.join("+");
}

/** True when focus is in a text-editing element, where single-key shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
      type,
    );
  }
  return false;
}
