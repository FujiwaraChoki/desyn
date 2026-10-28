"use client";

import type { VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { cn } from "../lib/cn.ts";
import { fieldShell } from "../lib/styles.ts";
import { inputShellVariants } from "../lib/variants.ts";
import { useFieldControlProps } from "./field.tsx";

export interface InputProps
  extends Omit<ComponentPropsWithoutRef<"input">, "size" | "prefix">,
    VariantProps<typeof inputShellVariants> {
  ref?: Ref<HTMLInputElement>;
  /** Content before the text (icon, label). */
  leading?: ReactNode;
  /** Content after the text (unit, clear button, shortcut). */
  trailing?: ReactNode;
  /** Classes for the outer shell (`className` styles the shell too; this is an alias for clarity). */
  shellClassName?: string;
  /** Classes for the `<input>` element itself. */
  inputClassName?: string;
  /** Marks the field invalid (also set automatically by a `Field` with an error). */
  invalid?: boolean;
}

/**
 * Text input on a surface-2 fill with a sun focus ring. `className` styles the shell; the ref and
 * all native props go to the `<input>`.
 */
export function Input({
  size,
  leading,
  trailing,
  className,
  shellClassName,
  inputClassName,
  invalid,
  id,
  disabled,
  required,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...props
}: InputProps) {
  const field = useFieldControlProps({
    id,
    disabled,
    required,
    "aria-describedby": describedBy,
    "aria-invalid": ariaInvalid ?? (invalid || undefined),
  });
  return (
    <div className={cn(inputShellVariants({ size }), className, shellClassName)}>
      {leading ? <span className="flex shrink-0 items-center text-fg-muted">{leading}</span> : null}
      <input
        {...field}
        className={cn(
          "h-full w-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-placeholder disabled:cursor-not-allowed",
          inputClassName,
        )}
        {...props}
      />
      {trailing ? (
        <span className="flex shrink-0 items-center text-fg-muted">{trailing}</span>
      ) : null}
    </div>
  );
}

export interface TextareaProps extends ComponentPropsWithoutRef<"textarea"> {
  ref?: Ref<HTMLTextAreaElement>;
  /** Grow with content (CSS `field-sizing: content`) between `minRows` and `maxRows`. */
  autoResize?: boolean;
  minRows?: number;
  maxRows?: number;
  invalid?: boolean;
}

/** Multi-line text input matching `Input`. */
export function Textarea({
  className,
  autoResize = false,
  minRows = 3,
  maxRows = 12,
  invalid,
  id,
  disabled,
  required,
  style,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...props
}: TextareaProps) {
  const field = useFieldControlProps({
    id,
    disabled,
    required,
    "aria-describedby": describedBy,
    "aria-invalid": ariaInvalid ?? (invalid || undefined),
  });
  const lineHeight = 20;
  return (
    <textarea
      {...field}
      rows={autoResize ? undefined : minRows}
      style={{
        ...(autoResize
          ? { minHeight: minRows * lineHeight + 14, maxHeight: maxRows * lineHeight + 14 }
          : null),
        ...style,
      }}
      className={cn(
        fieldShell,
        "block w-full resize-y px-2.5 py-1.5 text-sm leading-5 outline-none placeholder:text-fg-placeholder focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger/70",
        autoResize && "field-sizing-content resize-none",
        className,
      )}
      {...props}
    />
  );
}
