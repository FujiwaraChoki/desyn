"use client";

import type { ConvexReactClient, Watch } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect, useState } from "react";
import { errorMessage } from "../sync/errors.ts";

/**
 * A reactive value from the backend (a Convex query subscription in the app, a scripted source in tests).
 * `subscribe` calls `onValue` with the current value as soon as it is known and on every change.
 */
export interface Live<T> {
  subscribe(onValue: (value: T) => void, onError?: (error: unknown) => void): () => void;
}

/** A Convex query as a `Live` value (`watchQuery`; errors surface through `localQueryResult`). */
export function liveQuery<Args extends Record<string, unknown>, T>(
  client: ConvexReactClient,
  ref: FunctionReference<"query", "public", Args, T>,
  args: Args,
): Live<T> {
  return {
    subscribe(onValue, onError) {
      // The generic `Args` defeats convex's conditional argument typing; the reference carries the types.
      const watchQuery = client.watchQuery.bind(client) as (r: typeof ref, a: Args) => Watch<T>;
      const watch = watchQuery(ref, args);
      let last: T | undefined;
      const read = () => {
        let value: T | undefined;
        try {
          value = watch.localQueryResult();
        } catch (e) {
          onError?.(e);
          return;
        }
        if (value !== undefined && value !== last) {
          last = value;
          onValue(value);
        }
      };
      const off = watch.onUpdate(read);
      read();
      return off;
    },
  };
}

/** A fixed value (tests, hosts without a backend). */
export function liveValue<T>(value: T): Live<T> {
  return {
    subscribe(onValue) {
      onValue(value);
      return () => {};
    },
  };
}

export interface LiveState<T> {
  data: T | undefined;
  error: string | null;
  /** Error code of a ConvexError (FEATURE_UNAVAILABLE, FORBIDDEN...), when there is one. */
  code: string | null;
}

/**
 * Subscribes to a `Live` value while mounted. `key` identifies the subscription: a new key resubscribes
 * (the factory is only called when the key changes, so it may build a new `Live` every render).
 */
export function useLive<T>(key: string | null, factory: () => Live<T> | null): LiveState<T> {
  const [state, setState] = useState<LiveState<T> & { key: string | null }>({
    key,
    data: undefined,
    error: null,
    code: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the factory's result
  useEffect(() => {
    if (key === null) return;
    const live = factory();
    if (!live) return;
    setState((s) => (s.key === key ? s : { key, data: undefined, error: null, code: null }));
    return live.subscribe(
      (data) => setState({ key, data, error: null, code: null }),
      (e) =>
        setState((s) => ({
          key,
          data: s.key === key ? s.data : undefined,
          error: errorMessage(e),
          code: errorCode(e),
        })),
    );
  }, [key]);
  if (state.key !== key) return { data: undefined, error: null, code: null };
  return { data: state.data, error: state.error, code: state.code };
}

/** The `code` of a ConvexError-shaped error, or null. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { data: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** A message for people from any thrown value (ConvexError data, Error, string). */
export { errorMessage };
