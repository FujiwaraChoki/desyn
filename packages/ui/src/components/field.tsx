"use client";

import { Label as LabelPrimitive } from "radix-ui";
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useContext,
  useId,
  useMemo,
} from "react";
import { cn } from "../lib/cn.ts";

interface FieldContextValue {
  id: string;
  labelId: string;
  helpId: string;
  errorId: string;
  invalid: boolean;
  disabled: boolean;
  required: boolean;
  hasHelp: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Field wiring for custom controls: ids and `aria-*` props for the control inside a `Field`. */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

/**
 * Props a control should spread to be labelled and described by its `Field`. Explicit props on the
 * control win.
 */
export function useFieldControlProps(own: {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: ComponentPropsWithoutRef<"input">["aria-invalid"];
  disabled?: boolean;
  required?: boolean;
}) {
  const field = useField();
  if (!field) return own;
  const describedBy =
    [
      own["aria-describedby"],
      field.hasHelp ? field.helpId : null,
      field.invalid ? field.errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return {
    id: own.id ?? field.id,
    "aria-describedby": describedBy,
    "aria-invalid": own["aria-invalid"] ?? (field.invalid || undefined),
    disabled: own.disabled ?? (field.disabled || undefined),
    required: own.required ?? (field.required || undefined),
  };
}

export interface FieldProps extends ComponentPropsWithoutRef<"div"> {
  /** Label text or node. */
  label?: ReactNode;
  /** Help text below the control. */
  help?: ReactNode;
  /** Error message; marks the control invalid when set. */
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** `stacked` (label above) or `inline` (label left, for dense inspectors). */
  layout?: "stacked" | "inline";
  /** Control id override. */
  controlId?: string;
}

/**
 * Groups a label, a control, help and error text, and wires `id`, `aria-describedby` and
 * `aria-invalid` into Desyn inputs placed inside it.
 */
export function Field({
  label,
  help,
  error,
  required = false,
  disabled = false,
  layout = "stacked",
  controlId,
  className,
  children,
  ...props
}: FieldProps) {
  const auto = useId();
  const id = controlId ?? `field-${auto}`;
  const invalid = error !== undefined && error !== null && error !== false && error !== "";
  const hasHelp = help !== undefined && help !== null && help !== false && help !== "";
  const value = useMemo(
    () => ({
      id,
      labelId: `${id}-label`,
      helpId: `${id}-help`,
      errorId: `${id}-error`,
      invalid,
      disabled,
      required,
      hasHelp,
    }),
    [id, invalid, disabled, required, hasHelp],
  );
  return (
    <FieldContext.Provider value={value}>
      <div
        data-invalid={invalid || undefined}
        data-disabled={disabled || undefined}
        className={cn(
          layout === "stacked"
            ? "flex flex-col gap-1.5"
            : "grid grid-cols-[minmax(72px,auto)_1fr] items-center gap-x-3 gap-y-1",
          className,
        )}
        {...props}
      >
        {label ? <Label>{label}</Label> : null}
        <div className={cn("min-w-0", layout === "inline" && "col-start-2")}>{children}</div>
        {hasHelp && !invalid ? (
          <HelpText className={cn(layout === "inline" && "col-start-2")}>{help}</HelpText>
        ) : null}
        {invalid ? (
          <ErrorText className={cn(layout === "inline" && "col-start-2")}>{error}</ErrorText>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

export interface LabelProps extends ComponentPropsWithoutRef<typeof LabelPrimitive.Root> {
  /** Shows a sun asterisk (defaults to the field's `required`). */
  required?: boolean;
}

/** Form label. Inside a `Field` it targets the field's control automatically. */
export function Label({ className, required, children, htmlFor, id, ...props }: LabelProps) {
  const field = useField();
  const showRequired = required ?? field?.required ?? false;
  return (
    <LabelPrimitive.Root
      htmlFor={htmlFor ?? field?.id}
      id={id ?? field?.labelId}
      className={cn(
        "inline-flex select-none items-center gap-1 text-xs font-medium text-fg-secondary",
        field?.disabled && "opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      {showRequired ? (
        <span aria-hidden className="text-accent">
          *
        </span>
      ) : null}
    </LabelPrimitive.Root>
  );
}

/** Secondary guidance below a control. */
export function HelpText({ className, id, ...props }: ComponentPropsWithoutRef<"p">) {
  const field = useField();
  return (
    <p id={id ?? field?.helpId} className={cn("text-xs text-fg-muted", className)} {...props} />
  );
}

/** Validation message below a control; announced politely when it appears. */
export function ErrorText({ className, id, ...props }: ComponentPropsWithoutRef<"p">) {
  const field = useField();
  return (
    <p
      id={id ?? field?.errorId}
      role="alert"
      aria-live="polite"
      className={cn("text-xs text-danger", className)}
      {...props}
    />
  );
}
