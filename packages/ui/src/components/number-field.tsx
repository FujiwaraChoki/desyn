"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { constrain, evaluateExpression, roundTo } from "../lib/expression.ts";
import { inputShellVariants } from "../lib/variants.ts";
import { useFieldControlProps } from "./field.tsx";

/** Pixels of pointer travel per step while scrubbing. */
const PX_PER_STEP = 2;
/** Pointer travel before a press on the label becomes a scrub (so a click still focuses). */
const SCRUB_THRESHOLD = 3;

export interface NumberFieldProps {
  ref?: Ref<HTMLInputElement>;
  /** Current value; `null` renders the "Mixed" state for multi-selections. */
  value?: number | null;
  defaultValue?: number | null;
  /** Fires on every change, including each scrub step (use for live preview). */
  onChange?: (value: number) => void;
  /**
   * Fires once per gesture: scrub release, Enter/blur after typing, or an arrow-key step. Commit
   * document transactions here.
   */
  onChangeEnd?: (value: number) => void;
  min?: number;
  max?: number;
  /** Arrow/scrub increment. */
  step?: number;
  /** Increment with Shift (default step x 10). */
  largeStep?: number;
  /** Increment with Alt (default step / 10). */
  smallStep?: number;
  /** Decimals kept (default: derived from `smallStep`). */
  precision?: number;
  /** Unit shown after the value (`px`, `°`, `%`). Also accepted when typed in expressions. */
  unit?: string;
  /** Extra units accepted (and ignored) in typed expressions, e.g. `["px", "pt"]`. */
  acceptUnits?: string[];
  /** Scrub handle: a short text (`W`, `X`) or icon. Dragging it horizontally changes the value. */
  label?: ReactNode;
  /** Accessible name; required when `label` is not plain text. */
  "aria-label"?: string;
  /** Tooltip-style title on the scrub handle. */
  scrubTitle?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
  className?: string;
  inputClassName?: string;
  /** Custom display formatting (value is already rounded to `precision`). */
  format?: (value: number) => string;
}

function decimalsOf(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? (s.split(".")[1]?.length ?? 0) : 0;
}

/**
 * Numeric input for inspectors. Drag the label to scrub (Shift = x10, Alt = /10), use ↑/↓
 * (with Shift/Alt) to step, type arithmetic like `100/2` or `(12+4)*2`, Enter to commit, Escape to
 * revert. Renders `role="spinbutton"` with the current value for assistive tech.
 */
export function NumberField({
  ref,
  value: valueProp,
  defaultValue = null,
  onChange,
  onChangeEnd,
  min = -Infinity,
  max = Infinity,
  step = 1,
  largeStep,
  smallStep,
  precision,
  unit,
  acceptUnits = [],
  label,
  "aria-label": ariaLabel,
  scrubTitle,
  size = "md",
  disabled,
  placeholder,
  id,
  name,
  className,
  inputClassName,
  format,
}: NumberFieldProps) {
  const big = largeStep ?? step * 10;
  const small = smallStep ?? step / 10;
  const digits = precision ?? Math.max(decimalsOf(step), decimalsOf(small));
  const [inner, setInner] = useState<number | null>(defaultValue);
  const controlled = valueProp !== undefined;
  const value = controlled ? valueProp : inner;
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const autoId = useId();
  const fieldProps = useFieldControlProps({ id, disabled });
  const field = { ...fieldProps, id: fieldProps.id ?? `nf-${autoId}` };
  const units = unit ? [unit, ...acceptUnits] : acceptUnits;

  const clampValue = useCallback(
    (n: number) => constrain(n, { min, max, precision: digits }),
    [min, max, digits],
  );
  const display = (n: number | null) => {
    if (n === null) return "";
    const rounded = roundTo(n, digits);
    return format ? format(rounded) : String(rounded);
  };

  const emit = useCallback(
    (next: number, end: boolean) => {
      if (!controlled) setInner(next);
      onChange?.(next);
      if (end) onChangeEnd?.(next);
    },
    [controlled, onChange, onChangeEnd],
  );

  const commitDraft = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    setDraft(null);
    if (trimmed === "" || trimmed === display(value)) return;
    const result = evaluateExpression(trimmed, units);
    if (result === null) return; // Invalid input reverts to the last good value.
    const next = clampValue(result);
    if (next !== value) emit(next, true);
  };

  const setTo = (target: number) => {
    const next = clampValue(target);
    setDraft(null);
    if (next !== value) emit(next, true);
  };
  const stepBy = (delta: number) => setTo((value ?? (Number.isFinite(min) ? min : 0)) + delta);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const inc = e.shiftKey ? big : e.altKey ? small : step;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        stepBy(inc);
        break;
      case "ArrowDown":
        e.preventDefault();
        stepBy(-inc);
        break;
      case "PageUp":
        e.preventDefault();
        stepBy(big);
        break;
      case "PageDown":
        e.preventDefault();
        stepBy(-big);
        break;
      case "Home":
        if (Number.isFinite(min) && draft === null) {
          e.preventDefault();
          setTo(min);
        }
        break;
      case "End":
        if (Number.isFinite(max) && draft === null) {
          e.preventDefault();
          setTo(max);
        }
        break;
      case "Enter":
        e.preventDefault();
        commitDraft();
        e.currentTarget.select();
        break;
      case "Escape":
        if (draft !== null) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(null);
        }
        break;
    }
  };

  // ---- Scrubbing ----------------------------------------------------------------------------
  const scrub = useRef<{
    pointerId: number;
    startX: number;
    travel: number;
    startValue: number;
    last: number;
    active: boolean;
    locked: boolean;
  } | null>(null);

  const onScrubDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const start = value ?? (Number.isFinite(min) ? min : 0);
    scrub.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      travel: 0,
      startValue: start,
      last: start,
      active: false,
      locked: false,
    };
  };

  const onScrubMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = scrub.current;
    if (!s || e.pointerId !== s.pointerId) return;
    // Pointer lock gives unbounded travel (no screen edge); fall back to absolute deltas.
    if (s.locked) s.travel += e.movementX;
    else s.travel = e.clientX - s.startX;
    if (!s.active) {
      if (Math.abs(s.travel) < SCRUB_THRESHOLD) return;
      s.active = true;
      setScrubbing(true);
      setDraft(null);
      const el = e.currentTarget;
      if (typeof el.requestPointerLock === "function") {
        try {
          const maybe = el.requestPointerLock() as unknown;
          s.locked = true;
          s.travel = 0;
          s.startX = e.clientX;
          if (maybe instanceof Promise) maybe.catch(() => (s.locked = false));
        } catch {
          s.locked = false;
        }
      }
    }
    const inc = e.shiftKey ? big : e.altKey ? small : step;
    const steps = Math.trunc(s.travel / PX_PER_STEP);
    const next = clampValue(s.startValue + steps * inc);
    if (next !== s.last) {
      s.last = next;
      emit(next, false);
    }
  };

  const endScrub = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = scrub.current;
    if (!s || e.pointerId !== s.pointerId) return;
    scrub.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (typeof document !== "undefined" && document.pointerLockElement)
      document.exitPointerLock?.();
    setScrubbing(false);
    if (!s.active) {
      // A click on the label focuses the input for typing.
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (cancelled) {
      emit(s.startValue, false);
      return;
    }
    if (s.last !== s.startValue) onChangeEnd?.(s.last);
  };

  // Escape cancels a scrub in progress. The label isn't focusable, so listen on the window.
  useEffect(() => {
    if (!scrubbing) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const s = scrub.current;
      if (e.key !== "Escape" || !s?.active) return;
      e.preventDefault();
      scrub.current = null;
      setScrubbing(false);
      if (document.pointerLockElement) document.exitPointerLock?.();
      emit(s.startValue, false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [scrubbing, emit]);

  const setRefs = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const textLabel = typeof label === "string" ? label : undefined;
  const shown = draft ?? display(value);

  return (
    <div
      className={cn(
        inputShellVariants({ size }),
        "gap-0 pr-0 pl-0",
        scrubbing && "border-transparent ring-2 ring-ring",
        className,
      )}
      data-scrubbing={scrubbing || undefined}
    >
      {label !== undefined ? (
        <label
          htmlFor={field.id}
          title={scrubTitle}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={(e) => endScrub(e, false)}
          onPointerCancel={(e) => endScrub(e, true)}
          data-scrub-handle=""
          className={cn(
            "flex h-full shrink-0 cursor-ew-resize select-none items-center justify-center pl-2 pr-1 text-fg-muted transition-colors hover:text-fg [&_svg]:size-3.5",
            size === "sm" ? "min-w-6 text-2xs" : "min-w-7 text-xs",
            scrubbing && "text-accent",
            disabled && "pointer-events-none",
          )}
        >
          {label}
        </label>
      ) : null}
      <input
        ref={setRefs}
        {...field}
        name={name}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        role="spinbutton"
        aria-label={ariaLabel ?? textLabel}
        aria-valuenow={value ?? undefined}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        aria-valuetext={value === null ? "Mixed" : `${display(value)}${unit ? ` ${unit}` : ""}`}
        placeholder={value === null ? (placeholder ?? "Mixed") : placeholder}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commitDraft}
        onKeyDown={onKeyDown}
        className={cn(
          "dsn-no-spin h-full w-full min-w-0 flex-1 bg-transparent font-sans tabular-nums text-fg outline-none placeholder:text-fg-placeholder disabled:cursor-not-allowed",
          label === undefined ? "pl-2.5" : "pl-0.5",
          unit ? "pr-0" : "pr-2",
          inputClassName,
        )}
      />
      {unit ? (
        <span aria-hidden className="pointer-events-none shrink-0 pr-2 pl-1 text-xs text-fg-muted">
          {unit}
        </span>
      ) : null}
    </div>
  );
}
