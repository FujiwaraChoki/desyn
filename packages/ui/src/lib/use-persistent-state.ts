"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

/*
 * localStorage-backed state that is safe to server-render and hydrate: the server and the
 * hydration render both use the fallback, then React re-renders with the stored value before the
 * browser paints. Values are shared by every hook using the same key, follow writes from other
 * tabs (`storage` events), and fall back to memory when storage is blocked (private mode).
 */

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
/** Last parsed value per key, keyed by the raw string so snapshots stay referentially stable. */
const cache = new Map<string, { raw: string | null; value: unknown }>();
/** Values written while storage is unavailable. */
const memory = new Map<string, unknown>();

function notify(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function snapshot<T>(key: string, isValid: (v: unknown) => v is T): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  const raw = readRaw(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T | undefined;
  let value: T | undefined;
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      value = isValid(parsed) ? parsed : undefined;
    } catch {
      value = undefined;
    }
  }
  cache.set(key, { raw, value });
  return value;
}

function subscribe(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Writes a persisted value and updates every hook bound to `key` in this document. */
export function writePersistentState(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    memory.delete(key);
  } catch {
    // Storage full or blocked: keep the value in memory for this session.
    memory.set(key, value);
  }
  notify(key);
}

/**
 * `[value, setValue]` persisted under `key` (no persistence when `key` is `null`). `fallback` is
 * used when nothing valid is stored; pass a stable value (a constant or memoized array).
 */
export function usePersistentState<T>(
  key: string | null,
  isValid: (v: unknown) => v is T,
  fallback: T,
): [T, (next: T) => void] {
  const [local, setLocal] = useState(fallback);
  const subscribeKey = useCallback(
    (listener: Listener) => (key ? subscribe(key, listener) : () => {}),
    [key],
  );
  const stored = useSyncExternalStore(
    subscribeKey,
    () => (key ? snapshot(key, isValid) : undefined),
    () => undefined,
  );
  const value = key ? (stored ?? fallback) : local;
  const set = useCallback(
    (next: T) => {
      if (key) writePersistentState(key, next);
      else setLocal(next);
    },
    [key],
  );
  return [value, set];
}
