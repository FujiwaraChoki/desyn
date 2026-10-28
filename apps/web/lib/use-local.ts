"use client";

import { useCallback, useSyncExternalStore } from "react";

/*
 * Hydration-safe localStorage state: the server and the hydration render see `fallback`, the stored
 * value applies right after. Changes propagate to every hook using the same key (and other tabs).
 */

const listeners = new Map<string, Set<() => void>>();
const memory = new Map<string, string | null>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function notify(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key) notify(event.key);
  });
}

export function usePersistentLocal<T>(key: string, fallback: T): [T, (value: T) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      return () => set?.delete(cb);
    },
    [key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  let value = fallback;
  if (raw !== null) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = fallback;
    }
  }
  const set = useCallback(
    (next: T) => {
      const json = JSON.stringify(next);
      try {
        localStorage.setItem(key, json);
      } catch {
        memory.set(key, json);
      }
      notify(key);
    },
    [key],
  );
  return [value, set];
}
