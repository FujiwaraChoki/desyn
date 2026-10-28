"use client";

import { Slider as SliderPrimitive } from "radix-ui";
import { type ComponentPropsWithoutRef, useState } from "react";
import { cn } from "../lib/cn.ts";

export interface SliderProps
  extends Omit<
    ComponentPropsWithoutRef<typeof SliderPrimitive.Root>,
    "value" | "defaultValue" | "onValueChange" | "onValueCommit"
  > {
  /** One value for a single thumb, two for a range. */
  value?: number[];
  defaultValue?: number[];
  /** Fires continuously while dragging. */
  onValueChange?: (value: number[]) => void;
  /** Fires once when the drag ends or a key step is applied. */
  onValueCommit?: (value: number[]) => void;
  /** Accessible names per thumb, e.g. `["Minimum", "Maximum"]`. Defaults to `aria-label`. */
  thumbLabels?: string[];
  /** Show the value above the thumb while interacting. */
  showValue?: boolean;
  /** Formats values for the bubble and `aria-valuetext`. */
  formatValue?: (value: number) => string;
  size?: "sm" | "md";
}

/** Single or range slider with a glowing sun fill. Arrow keys step, Shift+Arrow steps x10. */
export function Slider({
  className,
  value,
  defaultValue,
  onValueChange,
  onValueCommit,
  thumbLabels,
  showValue = false,
  formatValue = (v) => String(v),
  size = "md",
  min = 0,
  max = 100,
  "aria-label": ariaLabel,
  ...props
}: SliderProps) {
  const [inner, setInner] = useState<number[]>(defaultValue ?? [min]);
  const values = value ?? inner;
  const [active, setActive] = useState(false);
  return (
    <SliderPrimitive.Root
      min={min}
      max={max}
      value={values}
      onValueChange={(v) => {
        if (value === undefined) setInner(v);
        onValueChange?.(v);
      }}
      onValueCommit={(v) => {
        setActive(false);
        onValueCommit?.(v);
      }}
      onPointerDown={() => setActive(true)}
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[disabled]:opacity-45 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        size === "sm" ? "h-4" : "h-5",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          "relative grow overflow-hidden rounded-full bg-fg/12 data-[orientation=vertical]:h-full",
          size === "sm"
            ? "h-[3px] data-[orientation=vertical]:w-[3px]"
            : "h-1 data-[orientation=vertical]:w-1",
        )}
      >
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent data-[orientation=vertical]:w-full" />
      </SliderPrimitive.Track>
      {values.map((v, i) => (
        <SliderPrimitive.Thumb
          // biome-ignore lint/suspicious/noArrayIndexKey: thumbs are positional
          key={i}
          aria-label={thumbLabels?.[i] ?? ariaLabel}
          aria-valuetext={formatValue(v)}
          onFocus={() => showValue && setActive(true)}
          onBlur={() => setActive(false)}
          className={cn(
            "group relative block cursor-grab rounded-full border border-black/10 bg-white shadow-[0_1px_3px_rgb(0_0_0/0.4)] outline-none transition-[box-shadow,transform] duration-200 ease-out hover:shadow-[0_1px_3px_rgb(0_0_0/0.4),0_0_0_4px_var(--accent-tint)] focus-visible:shadow-[0_1px_3px_rgb(0_0_0/0.4),0_0_0_4px_var(--ring)] active:cursor-grabbing active:scale-110",
            size === "sm" ? "size-3" : "size-3.5",
          )}
        >
          {showValue && active ? (
            <span className="-translate-x-1/2 pointer-events-none absolute bottom-full left-1/2 mb-2 rounded-[5px] bg-surface-3 px-1.5 py-0.5 font-sans text-2xs tabular-nums text-fg shadow-popover">
              {formatValue(v)}
            </span>
          ) : null}
        </SliderPrimitive.Thumb>
      ))}
    </SliderPrimitive.Root>
  );
}
