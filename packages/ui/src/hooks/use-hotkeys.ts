"use client";

import { useEffect, useRef } from "react";
import {
  detectPlatform,
  isEditableTarget,
  matchesShortcut,
  parseShortcut,
} from "../lib/platform.ts";

export type HotkeyHandler = (event: KeyboardEvent) => void;

export interface UseHotkeysOptions {
  /** Turn all bindings off without unmounting (default true). */
  enabled?: boolean;
  /**
   * Fire while typing in inputs. By default single-key shortcuts are ignored in text fields while
   * shortcuts with ⌘/Ctrl/Alt still fire.
   */
  allowInInputs?: boolean;
  /** Call `preventDefault()` on matches (default true). */
  preventDefault?: boolean;
  /** Element to listen on (default `window`). */
  target?: HTMLElement | Window | null;
  /** Listen in the capture phase (to beat component handlers). */
  capture?: boolean;
  /** Ignore auto-repeat events from a held key. */
  ignoreRepeat?: boolean;
}

/**
 * Binds keyboard shortcuts written as `"mod+k"`, `"shift+?"`, `"delete"`, `"mod+shift+z"`
 * (`mod` = ⌘ on Apple, Ctrl elsewhere). Several shortcuts can share a handler with a comma:
 * `"backspace, delete"`. Handlers always see the latest closure.
 *
 * @example
 * useHotkeys({ "mod+z": undo, "mod+shift+z, mod+y": redo, "v": selectTool });
 */
export function useHotkeys(
  bindings: Record<string, HotkeyHandler>,
  options: UseHotkeysOptions = {},
): void {
  const {
    enabled = true,
    allowInInputs = false,
    preventDefault = true,
    target,
    capture = false,
    ignoreRepeat = false,
  } = options;
  const latest = useRef(bindings);
  latest.current = bindings;
  const signature = Object.keys(bindings).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-bind only when the set of shortcuts changes; handlers are read from a ref
  useEffect(() => {
    if (!enabled) return;
    const el = target === undefined ? (typeof window === "undefined" ? null : window) : target;
    if (!el) return;
    const platform = detectPlatform();
    const parsed = Object.keys(latest.current).flatMap((combo) =>
      combo
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => ({ combo, shortcut: parseShortcut(c) })),
    );
    const onKey = (event: Event) => {
      const e = event as KeyboardEvent;
      if (ignoreRepeat && e.repeat) return;
      for (const { combo, shortcut } of parsed) {
        if (!matchesShortcut(e, shortcut, platform)) continue;
        const hasModifier = shortcut.mod || shortcut.ctrl || shortcut.meta || shortcut.alt;
        if (!allowInInputs && !hasModifier && isEditableTarget(e.target)) continue;
        if (preventDefault) e.preventDefault();
        latest.current[combo]?.(e);
        return;
      }
    };
    el.addEventListener("keydown", onKey, capture);
    return () => el.removeEventListener("keydown", onKey, capture);
  }, [signature, enabled, allowInInputs, preventDefault, target, capture, ignoreRepeat]);
}
