"use client";

import { springSnappy } from "@desyn/tokens/motion";
import type { VariantProps } from "class-variance-authority";
import { LayoutGroup, motion } from "motion/react";
import {
  RadioGroup as RadioGroupPrimitive,
  ToggleGroup as ToggleGroupPrimitive,
  Toggle as TogglePrimitive,
} from "radix-ui";
import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react";
import { cn } from "../lib/cn.ts";
import { focusRing } from "../lib/styles.ts";
import { iconButtonVariants } from "../lib/variants.ts";
import { Tooltip } from "./tooltip.tsx";

export interface ToggleProps
  extends ComponentPropsWithoutRef<typeof TogglePrimitive.Root>,
    Pick<VariantProps<typeof iconButtonVariants>, "size" | "variant"> {
  /** Tooltip text (also the accessible name when the toggle has only an icon). */
  tooltip?: string;
  shortcut?: string;
}

/** Two-state button (bold, italic, snapping...). Pressed state is a neutral fill with a sun-colored label. */
export function Toggle({
  className,
  size,
  variant,
  tooltip,
  shortcut,
  children,
  ...props
}: ToggleProps) {
  const control = (
    <TogglePrimitive.Root
      aria-label={props["aria-label"] ?? tooltip}
      className={cn(iconButtonVariants({ size, variant }), "w-auto min-w-8 px-1.5", className)}
      {...props}
    >
      {children}
    </TogglePrimitive.Root>
  );
  return tooltip ? (
    <Tooltip content={tooltip} shortcut={shortcut}>
      {control}
    </Tooltip>
  ) : (
    control
  );
}

type ToggleGroupProps = ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>;

/** A set of toggles (single or multiple) with roving focus, e.g. text alignment. */
export function ToggleGroup({ className, ...props }: ToggleGroupProps) {
  return (
    <ToggleGroupPrimitive.Root
      className={cn("inline-flex items-center gap-0.5 rounded-[8px] bg-fg/5 p-0.5", className)}
      {...props}
    />
  );
}

export interface ToggleGroupItemProps
  extends ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> {
  tooltip?: string;
  shortcut?: string;
  size?: "xs" | "sm" | "md";
}

export function ToggleGroupItem({
  className,
  tooltip,
  shortcut,
  size = "sm",
  ...props
}: ToggleGroupItemProps) {
  const item = (
    <ToggleGroupPrimitive.Item
      aria-label={props["aria-label"] ?? tooltip}
      className={cn(
        iconButtonVariants({ size, variant: "ghost" }),
        "rounded-[6px] aria-pressed:bg-surface-3 aria-pressed:text-fg light:aria-pressed:bg-background aria-pressed:shadow-[0_1px_2px_rgb(0_0_0/0.25),inset_0_0_0_1px_var(--line-subtle)] data-[state=on]:bg-surface-3 light:data-[state=on]:bg-background data-[state=on]:text-fg data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.25),inset_0_0_0_1px_var(--line-subtle)]",
        className,
      )}
      {...props}
    />
  );
  return tooltip ? (
    <Tooltip content={tooltip} shortcut={shortcut}>
      {item}
    </Tooltip>
  ) : (
    item
  );
}

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Accessible name when `label` is an icon. */
  "aria-label"?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string>
  extends Omit<
    ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>,
    "value" | "defaultValue" | "onValueChange" | "orientation"
  > {
  options: SegmentedOption<V>[];
  value?: V;
  defaultValue?: V;
  onValueChange?: (value: V) => void;
  size?: "sm" | "md";
  /** Stretch segments to fill the width. */
  fullWidth?: boolean;
}

/**
 * Mutually exclusive segments (radiogroup semantics, arrow keys move selection) with a sliding
 * selection indicator.
 */
export function SegmentedControl<V extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  size = "md",
  fullWidth = false,
  className,
  ...props
}: SegmentedControlProps<V>) {
  const layoutId = useId();
  return (
    <LayoutGroup id={layoutId}>
      <RadioGroupPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={(v) => onValueChange?.(v as V)}
        orientation="horizontal"
        loop
        className={cn(
          "relative inline-flex items-stretch rounded-[8px] bg-fg/6 p-0.5 shadow-[inset_0_0_0_1px_var(--line-subtle)]",
          size === "sm" ? "h-7" : "h-8",
          fullWidth && "flex w-full",
          className,
        )}
        {...props}
      >
        {options.map((opt) => (
          <RadioGroupPrimitive.Item
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            aria-label={opt["aria-label"]}
            className={cn(
              "group relative flex min-w-0 cursor-pointer select-none items-center justify-center gap-1.5 rounded-[6px] px-2.5 font-medium text-fg-muted transition-colors duration-150 hover:text-fg-secondary data-[state=checked]:text-fg disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4",
              size === "sm" ? "text-xs" : "text-sm",
              fullWidth && "flex-1",
              focusRing,
              "focus-visible:outline-offset-0",
            )}
          >
            <RadioGroupPrimitive.Indicator asChild forceMount>
              <SegmentIndicator />
            </RadioGroupPrimitive.Indicator>
            <span className="relative z-[1] flex items-center gap-1.5 truncate">{opt.label}</span>
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </LayoutGroup>
  );
}

/** The sliding pill. Rendered only for the checked item; motion animates between items. */
function SegmentIndicator(props: ComponentPropsWithoutRef<"span"> & { "data-state"?: string }) {
  if (props["data-state"] !== "checked") return null;
  return (
    <motion.span
      layoutId="segment-indicator"
      transition={springSnappy}
      aria-hidden
      className="absolute inset-0 rounded-[6px] bg-surface-3 light:bg-background shadow-[0_1px_3px_rgb(0_0_0/0.25),inset_0_0_0_1px_var(--line-subtle)]"
    />
  );
}
