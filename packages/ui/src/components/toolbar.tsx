"use client";

import { Toolbar as ToolbarPrimitive } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { glassSurface } from "../lib/styles.ts";
import { iconButtonVariants } from "../lib/variants.ts";
import { Tooltip } from "./tooltip.tsx";

export interface ToolbarProps extends ComponentPropsWithoutRef<typeof ToolbarPrimitive.Root> {
  /** `floating` = glass pill over the canvas (tool dock, context toolbar); `bar` = flat strip. */
  variant?: "floating" | "bar";
}

/** Toolbar with roving focus (one tab stop, arrow keys between tools). */
export function Toolbar({ variant = "floating", className, ...props }: ToolbarProps) {
  return (
    <ToolbarPrimitive.Root
      className={cn(
        "flex items-center gap-0.5",
        variant === "floating" ? cn(glassSurface, "rounded-[12px] p-1") : "h-10 px-1",
        className,
      )}
      {...props}
    />
  );
}

export interface ToolbarButtonProps
  extends ComponentPropsWithoutRef<typeof ToolbarPrimitive.Button> {
  /** Accessible name and tooltip. */
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

export function ToolbarButton({
  label,
  shortcut,
  active,
  size = "md",
  className,
  ...props
}: ToolbarButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <ToolbarPrimitive.Button
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        className={cn(iconButtonVariants({ size, variant: "ghost" }), className)}
        {...props}
      />
    </Tooltip>
  );
}

export function ToolbarSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ToolbarPrimitive.Separator>) {
  return (
    <ToolbarPrimitive.Separator
      className={cn("mx-1 h-5 w-px shrink-0 bg-line-subtle", className)}
      {...props}
    />
  );
}

export function ToolbarToggleGroup({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ToolbarPrimitive.ToggleGroup>) {
  return (
    <ToolbarPrimitive.ToggleGroup
      className={cn("flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

export interface ToolbarToggleItemProps
  extends ComponentPropsWithoutRef<typeof ToolbarPrimitive.ToggleItem> {
  label: string;
  shortcut?: string;
  size?: "sm" | "md" | "lg";
}

/** A tool in a toggle group; the selected tool gets the sun treatment. */
export function ToolbarToggleItem({
  label,
  shortcut,
  size = "md",
  className,
  ...props
}: ToolbarToggleItemProps) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <ToolbarPrimitive.ToggleItem
        aria-label={label}
        className={cn(
          iconButtonVariants({ size, variant: "ghost" }),
          "data-[state=on]:bg-accent-solid data-[state=on]:text-accent-ink",
          className,
        )}
        {...props}
      />
    </Tooltip>
  );
}

export function ToolbarLink({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ToolbarPrimitive.Link>) {
  return (
    <ToolbarPrimitive.Link
      className={cn("px-2 text-sm text-fg-secondary hover:text-fg", className)}
      {...props}
    />
  );
}
