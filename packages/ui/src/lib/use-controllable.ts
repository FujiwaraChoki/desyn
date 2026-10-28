"use client";

import { useCallback, useRef, useState } from "react";

/**
 * State that is controlled when `value` is defined and uncontrolled otherwise. `onChange` fires
 * for every change requested by the component in both modes.
 */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const currentRef = useRef(current);
  currentRef.current = current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(currentRef.current) : next;
      if (Object.is(resolved, currentRef.current)) return;
      currentRef.current = resolved;
      if (!controlled) setInner(resolved);
      onChangeRef.current?.(resolved);
    },
    [controlled],
  );
  return [current, set];
}
