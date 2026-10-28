import { Fragment, type ReactNode } from "react";

/** Gestures are written in plain text next to the keys, not as key caps. */
const GESTURES = new Set(["click", "drag", "scroll", "rotate"]);

/** Keys that differ by platform. The inline head script sets html[data-os] to "mac" or "other". */
const PLATFORM: Record<string, { mac: string; other: string; label: string }> = {
  mod: { mac: "⌘", other: "Ctrl", label: "Command or Control" },
  alt: { mac: "⌥", other: "Alt", label: "Option or Alt" },
  shift: { mac: "⇧", other: "Shift", label: "Shift" },
  delete: { mac: "⌦", other: "Del", label: "Delete" },
  backspace: { mac: "⌫", other: "Backspace", label: "Backspace" },
  enter: { mac: "↩", other: "Enter", label: "Enter" },
};

const NAMED: Record<string, { text: string; label: string }> = {
  escape: { text: "Esc", label: "Escape" },
  space: { text: "Space", label: "Space" },
  tab: { text: "Tab", label: "Tab" },
  arrowkeys: { text: "← ↑ → ↓", label: "Arrow keys" },
  arrowleft: { text: "←", label: "Left arrow" },
  arrowright: { text: "→", label: "Right arrow" },
  arrowup: { text: "↑", label: "Up arrow" },
  arrowdown: { text: "↓", label: "Down arrow" },
  pageup: { text: "PgUp", label: "Page up" },
  pagedown: { text: "PgDn", label: "Page down" },
  home: { text: "Home", label: "Home" },
  end: { text: "End", label: "End" },
};

export function parseCombo(combo: string): string[] {
  if (combo === "+") return ["+"];
  return combo
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function KeyCap({ token }: { token: string }) {
  const platform = PLATFORM[token];
  if (platform) {
    return (
      <kbd aria-label={platform.label}>
        <span className="k-mac">{platform.mac}</span>
        <span className="k-other">{platform.other}</span>
      </kbd>
    );
  }
  const named = NAMED[token];
  if (named) return <kbd aria-label={named.label}>{named.text}</kbd>;
  return <kbd>{token.length === 1 ? token.toUpperCase() : token}</kbd>;
}

/** Renders a combo like "mod+shift+z" as platform-aware key caps. */
export function Keys({ combo }: { combo: string }) {
  const tokens = parseCombo(combo);
  const parts: ReactNode[] = [];
  tokens.forEach((token, i) => {
    const key = `${token}-${i}`;
    if (i > 0)
      parts.push(
        <span key={`${key}-plus`} className="keys-plus" aria-hidden>
          +
        </span>,
      );
    parts.push(
      GESTURES.has(token) ? (
        <span key={key} className="keys-gesture">
          {token}
        </span>
      ) : (
        <Fragment key={key}>
          <KeyCap token={token} />
        </Fragment>
      ),
    );
  });
  return <span className="keys">{parts}</span>;
}

/** A single literal key cap for prose. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
