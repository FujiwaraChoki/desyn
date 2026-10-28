"use client";

import type { VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { cn } from "../lib/cn.ts";
import { buttonVariants, iconButtonVariants } from "../lib/variants.ts";
import { SunSpinner } from "./spinner.tsx";
import { Tooltip } from "./tooltip.tsx";

export interface ButtonProps
  extends ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement>;
  /** Render the child element (e.g. a link) with button styles. */
  asChild?: boolean;
  /** Shows a sun spinner, sets `aria-busy` and disables the button. */
  loading?: boolean;
  /** Icon before the label (replaced by the spinner while loading). */
  leadingIcon?: ReactNode;
  /** Icon after the label. */
  trailingIcon?: ReactNode;
}

/**
 * The Desyn button. `primary` is the single sun action on a surface (it glows); `secondary` is
 * the default; `ghost` for toolbars; `outline` for quiet marketing actions; `danger` for
 * destructive confirmations; `link` for inline text actions.
 */
export function Button({
  className,
  variant,
  size,
  shape,
  asChild = false,
  loading = false,
  disabled,
  leadingIcon,
  trailingIcon,
  children,
  type,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const spinner = <SunSpinner size={size === "xl" ? "md" : "sm"} className="text-current" />;
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, shape }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      aria-disabled={asChild && (disabled || loading) ? true : undefined}
      type={asChild ? undefined : (type ?? "button")}
      data-loading={loading || undefined}
      {...props}
    >
      {loading ? spinner : leadingIcon}
      <Slot.Slottable>{children}</Slot.Slottable>
      {trailingIcon}
    </Comp>
  );
}

export interface IconButtonProps
  extends Omit<ComponentPropsWithoutRef<"button">, "aria-label">,
    VariantProps<typeof iconButtonVariants> {
  ref?: Ref<HTMLButtonElement>;
  /** Accessible name; also shown as the tooltip unless `tooltip={false}`. */
  label: string;
  /** Tooltip content (defaults to `label`); `false` disables it. */
  tooltip?: ReactNode | false;
  /** Shortcut shown in the tooltip, e.g. `"mod+d"`. */
  shortcut?: string;
  /** Toggle state; renders `aria-pressed` and the sun tint when true. */
  active?: boolean;
  /** Spinner instead of the icon. */
  loading?: boolean;
  asChild?: boolean;
}

/** Square icon-only button (24/28/32/36 px) with a built-in tooltip and accessible label. */
export function IconButton({
  label,
  tooltip,
  shortcut,
  active,
  loading,
  variant,
  size,
  shape,
  className,
  children,
  asChild,
  disabled,
  type,
  ...props
}: IconButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const button = (
    <Comp
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      aria-busy={loading || undefined}
      disabled={asChild ? undefined : disabled || loading}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(iconButtonVariants({ variant, size, shape }), className)}
      {...props}
    >
      {loading ? <SunSpinner size="sm" className="text-current" /> : children}
    </Comp>
  );
  if (tooltip === false) return button;
  return (
    <Tooltip content={tooltip ?? label} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
}

export interface ButtonGroupProps extends ComponentPropsWithoutRef<"div"> {
  ref?: Ref<HTMLDivElement>;
  /** Accessible name for the group. */
  label?: string;
  orientation?: "horizontal" | "vertical";
}

/** Joins adjacent buttons into one segmented unit with shared borders. */
export function ButtonGroup({
  label,
  orientation = "horizontal",
  className,
  ...props
}: ButtonGroupProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics and default chrome
    <div
      role="group"
      aria-label={label}
      data-orientation={orientation}
      className={cn(
        "inline-flex isolate",
        orientation === "horizontal"
          ? "flex-row [&>*:not(:first-child)]:-ml-px [&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none"
          : "flex-col [&>*:not(:first-child)]:-mt-px [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none",
        "[&>*:focus-visible]:z-10 [&>*:hover]:z-[1]",
        className,
      )}
      {...props}
    />
  );
}
