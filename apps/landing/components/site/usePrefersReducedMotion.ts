"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * prefers-reduced-motion, safe to branch the rendered tree on. The server cannot know the
 * preference, so hydration always renders the motion version (server snapshot `false`) and React
 * re-renders with the real value right after. motion's `useReducedMotion` returns the real value
 * on the first client render, which makes server and client markup differ (React error #418).
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
