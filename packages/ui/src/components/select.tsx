"use client";

import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { menuContent, menuItem, menuLabel, menuSeparator } from "../lib/styles.ts";
import { inputShellVariants } from "../lib/variants.ts";
import { useFieldControlProps } from "./field.tsx";
import { useFloatingLayer, usePortalContainer } from "./portal.tsx";

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export interface SelectTriggerProps
  extends ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  size?: "sm" | "md" | "lg";
  /** Icon before the value. */
  leading?: ReactNode;
}

/** Input-styled trigger with a chevron. */
export function SelectTrigger({
  className,
  size = "md",
  leading,
  children,
  id,
  disabled,
  ...props
}: SelectTriggerProps) {
  const field = useFieldControlProps({ id, disabled });
  return (
    <SelectPrimitive.Trigger
      {...field}
      className={cn(
        inputShellVariants({ size }),
        "group/trigger cursor-pointer justify-between text-left outline-none focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring data-[placeholder]:text-fg-placeholder data-[state=open]:border-line disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {leading ? <span className="flex shrink-0 items-center text-fg-muted">{leading}</span> : null}
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5! shrink-0 text-fg-muted transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** Glass listbox. Uses item-aligned positioning like native selects; pass `position="popper"` to drop below. */
export function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 4,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <SelectPrimitive.Portal container={container ?? undefined}>
      <SelectPrimitive.Content
        position={position}
        sideOffset={position === "popper" ? sideOffset : undefined}
        className={cn(
          layer,
          menuContent,
          "origin-(--radix-select-content-transform-origin) relative max-h-(--radix-select-content-available-height)",
          position === "popper" && "w-full min-w-(--radix-select-trigger-width)",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-5 cursor-default items-center justify-center text-fg-muted">
          <ChevronUp className="size-3.5" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-5 cursor-default items-center justify-center text-fg-muted">
          <ChevronDown className="size-3.5" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export interface SelectItemProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Item> {
  icon?: ReactNode;
  description?: ReactNode;
}

export function SelectItem({ className, children, icon, description, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      className={cn(menuItem, "pr-7", description && "h-auto py-1.5", className)}
      {...props}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description ? <span className="text-2xs text-fg-muted">{description}</span> : null}
      </span>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
        <Check className="size-3.5! text-accent!" strokeWidth={2.5} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn(menuLabel, className)} {...props} />;
}

export function SelectSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Text used for type-ahead and the closed trigger when `label` is rich. */
  textValue?: string;
  icon?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectOptionGroup<V extends string = string> {
  label: ReactNode;
  options: SelectOption<V>[];
}

export interface SelectProps<V extends string = string> {
  options: (SelectOption<V> | SelectOptionGroup<V>)[];
  value?: V;
  defaultValue?: V;
  onValueChange?: (value: V) => void;
  placeholder?: ReactNode;
  size?: SelectTriggerProps["size"];
  disabled?: boolean;
  name?: string;
  id?: string;
  /** Accessible name when not inside a `Field`. */
  "aria-label"?: string;
  className?: string;
  contentClassName?: string;
  leading?: ReactNode;
}

const isGroup = <V extends string>(
  o: SelectOption<V> | SelectOptionGroup<V>,
): o is SelectOptionGroup<V> => "options" in o;

/** Option-list select. For custom content use `SelectRoot` + `SelectTrigger` + `SelectContent`. */
export function Select<V extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  size,
  disabled,
  name,
  id,
  className,
  contentClassName,
  leading,
  "aria-label": ariaLabel,
}: SelectProps<V>) {
  const renderOption = (o: SelectOption<V>) => (
    <SelectItem
      key={o.value}
      value={o.value}
      disabled={o.disabled}
      textValue={o.textValue}
      icon={o.icon}
      description={o.description}
    >
      {o.label}
    </SelectItem>
  );
  return (
    <SelectRoot
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => onValueChange?.(v as V)}
      disabled={disabled}
      name={name}
    >
      <SelectTrigger
        size={size}
        id={id}
        aria-label={ariaLabel}
        className={className}
        leading={leading}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((o, i) =>
          isGroup(o) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: groups have no stable id; order is fixed
            <SelectGroup key={`g${i}`}>
              {i > 0 ? <SelectSeparator /> : null}
              <SelectLabel>{o.label}</SelectLabel>
              {o.options.map(renderOption)}
            </SelectGroup>
          ) : (
            renderOption(o)
          ),
        )}
      </SelectContent>
    </SelectRoot>
  );
}
