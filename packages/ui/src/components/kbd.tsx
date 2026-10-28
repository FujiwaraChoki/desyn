"use client";

import { type ComponentPropsWithoutRef, useSyncExternalStore } from "react";
import { cn } from "../lib/cn.ts";
import { detectPlatform, formatShortcut, type Platform, shortcutKeys } from "../lib/platform.ts";

const noopSubscribe = () => () => {};

/**
 * The current platform. Linux during SSR so server and first client render agree on non-Apple
 * machines; Apple clients re-render with mac glyphs after hydration.
 */
export function usePlatform(): Platform {
  return useSyncExternalStore(noopSubscribe, detectPlatform, () => "linux");
}

export interface KbdProps extends ComponentPropsWithoutRef<"kbd"> {
  size?: "sm" | "md";
}

/** A single key cap. */
export function Kbd({ className, size = "sm", ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center rounded-[4px] border border-line-subtle bg-fg/5 font-sans font-medium text-fg-muted shadow-[inset_0_-1px_0_var(--line-subtle)]",
        size === "sm" ? "h-[18px] min-w-[18px] px-1 text-2xs" : "h-6 min-w-6 px-1.5 text-xs",
        className,
      )}
      {...props}
    />
  );
}

export interface ShortcutProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  /** Shortcut string like `"mod+shift+k"`. */
  keys: string;
  /** Render each key as a cap (default) or as compact text (`⇧⌘K` / `Ctrl+Shift+K`). */
  variant?: "caps" | "text";
  size?: KbdProps["size"];
  /** Override platform detection (tests, docs). */
  platform?: Platform;
}

/**
 * A keyboard shortcut formatted for the user's OS. Screen readers get the spelled-out form via
 * `aria-label` (e.g. "Ctrl+Shift+K").
 */
export function Shortcut({
  keys,
  variant = "caps",
  size,
  platform,
  className,
  ...props
}: ShortcutProps) {
  const detected = usePlatform();
  const os = platform ?? detected;
  const parts = shortcutKeys(keys, os);
  const spoken = formatShortcut(keys, os === "mac" ? "mac" : os);
  if (variant === "text") {
    return (
      <span className={cn("font-sans text-2xs tracking-wide text-fg-muted", className)} {...props}>
        {spoken}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={parts.join(" ")}
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    >
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: keys of a shortcut are positional and may repeat
        <Kbd key={i} size={size} aria-hidden>
          {part}
        </Kbd>
      ))}
    </span>
  );
}
