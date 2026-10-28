"use client";

import { Check, Minus } from "lucide-react";
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Switch as SwitchPrimitive,
} from "radix-ui";
import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react";
import { cn } from "../lib/cn.ts";
import { focusRing } from "../lib/styles.ts";
import { useFieldControlProps } from "./field.tsx";

/** Optional inline label + description used by Switch, Checkbox and Radio items. */
function ChoiceLabel({
  htmlFor,
  label,
  description,
  disabled,
}: {
  htmlFor: string;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  if (!label && !description) return null;
  return (
    <span className={cn("flex min-w-0 flex-col gap-0.5", disabled && "opacity-50")}>
      {label ? (
        <label htmlFor={htmlFor} className="cursor-pointer select-none text-sm leading-4 text-fg">
          {label}
        </label>
      ) : null}
      {description ? <span className="text-xs text-fg-muted">{description}</span> : null}
    </span>
  );
}

export interface SwitchProps extends ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label?: ReactNode;
  description?: ReactNode;
  size?: "sm" | "md";
}

/** On/off switch; the track fills with sun and glows when on. */
export function Switch({
  label,
  description,
  size = "md",
  className,
  id,
  disabled,
  ...props
}: SwitchProps) {
  const auto = useId();
  const fieldProps = useFieldControlProps({ id, disabled });
  const field = { ...fieldProps, id: fieldProps.id ?? `sw-${auto}` };
  const control = (
    <SwitchPrimitive.Root
      {...field}
      className={cn(
        "peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-fg/16 transition-[background-color,box-shadow] duration-200 ease-out hover:bg-fg/22 data-[state=checked]:bg-accent-solid disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-4 w-7" : "h-[20px] w-[34px]",
        focusRing,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.35)] transition-transform duration-300 ease-out data-[state=unchecked]:translate-x-[2px]",
          size === "sm"
            ? "size-3 data-[state=checked]:translate-x-[13px]"
            : "size-4 data-[state=checked]:translate-x-[15px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
  if (!label && !description) return control;
  return (
    <span className="inline-flex items-start gap-2.5">
      {control}
      <ChoiceLabel
        htmlFor={field.id}
        label={label}
        description={description}
        disabled={field.disabled}
      />
    </span>
  );
}

export interface CheckboxProps extends ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  label?: ReactNode;
  description?: ReactNode;
}

/** Checkbox with indeterminate support (`checked="indeterminate"`). */
export function Checkbox({ label, description, className, id, disabled, ...props }: CheckboxProps) {
  const auto = useId();
  const fieldProps = useFieldControlProps({ id, disabled });
  const field = { ...fieldProps, id: fieldProps.id ?? `cb-${auto}` };
  const control = (
    <CheckboxPrimitive.Root
      {...field}
      className={cn(
        "peer grid size-4 shrink-0 cursor-pointer place-items-center rounded-[4px] border border-line-strong bg-surface-2 text-accent-ink transition-[background-color,border-color,box-shadow] duration-150 hover:border-fg/60 data-[state=checked]:border-transparent data-[state=checked]:bg-accent-solid data-[state=indeterminate]:border-transparent data-[state=indeterminate]:bg-accent-solid disabled:cursor-not-allowed disabled:opacity-45 aria-[invalid=true]:border-danger",
        focusRing,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label && !description) return control;
  return (
    <span className="inline-flex items-start gap-2.5">
      {control}
      <ChoiceLabel
        htmlFor={field.id}
        label={label}
        description={description}
        disabled={field.disabled}
      />
    </span>
  );
}

export type RadioGroupProps = ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>;

/** Radio group with roving focus (arrow keys move and select). */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
  return <RadioGroupPrimitive.Root className={cn("flex flex-col gap-2.5", className)} {...props} />;
}

export interface RadioGroupItemProps
  extends ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> {
  label?: ReactNode;
  description?: ReactNode;
}

/** A radio button; the selected dot glows sun. */
export function RadioGroupItem({
  label,
  description,
  className,
  id,
  ...props
}: RadioGroupItemProps) {
  const auto = useId();
  const itemId = id ?? `rd-${auto}`;
  const control = (
    <RadioGroupPrimitive.Item
      id={itemId}
      className={cn(
        "peer grid size-4 shrink-0 cursor-pointer place-items-center rounded-full border border-line-strong bg-surface-2 transition-[border-color,box-shadow] duration-150 hover:border-fg/60 data-[state=checked]:border-accent disabled:cursor-not-allowed disabled:opacity-45",
        focusRing,
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-2 rounded-full bg-accent" />
    </RadioGroupPrimitive.Item>
  );
  if (!label && !description) return control;
  return (
    <span className="inline-flex items-start gap-2.5">
      {control}
      <ChoiceLabel
        htmlFor={itemId}
        label={label}
        description={description}
        disabled={props.disabled}
      />
    </span>
  );
}
