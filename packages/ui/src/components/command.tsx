"use client";

import { Command as Cmdk } from "cmdk";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ComponentPropsWithoutRef, type ReactNode, useState } from "react";
import { useHotkeys } from "../hooks/use-hotkeys.ts";
import { cn } from "../lib/cn.ts";
import { layers } from "../lib/layers.ts";
import { focusRing, menuItem } from "../lib/styles.ts";
import { inputShellVariants } from "../lib/variants.ts";
import { useFieldControlProps } from "./field.tsx";
import { Shortcut } from "./kbd.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { ModalLayerProvider, usePortalContainer } from "./portal.tsx";
import { SunSpinner } from "./spinner.tsx";

/** Filterable command list (cmdk). Compose with the parts below. */
export function Command({ className, ...props }: ComponentPropsWithoutRef<typeof Cmdk>) {
  return (
    <Cmdk className={cn("flex flex-col overflow-hidden text-fg", className)} loop {...props} />
  );
}

export function CommandInput({ className, ...props }: ComponentPropsWithoutRef<typeof Cmdk.Input>) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line-subtle px-3.5">
      <Search className="size-4 shrink-0 text-fg-muted" aria-hidden />
      <Cmdk.Input
        className={cn(
          "h-12 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-placeholder",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentPropsWithoutRef<typeof Cmdk.List>) {
  return (
    <Cmdk.List
      className={cn(
        "max-h-[min(420px,60dvh)] overflow-y-auto overscroll-contain p-1.5 scroll-py-1.5",
        className,
      )}
      {...props}
    />
  );
}

export function CommandEmpty({
  className,
  children = "No results",
  ...props
}: ComponentPropsWithoutRef<typeof Cmdk.Empty>) {
  return (
    <Cmdk.Empty className={cn("px-3 py-8 text-center text-sm text-fg-muted", className)} {...props}>
      {children}
    </Cmdk.Empty>
  );
}

export function CommandLoading({
  className,
  children = "Loading",
  ...props
}: ComponentPropsWithoutRef<typeof Cmdk.Loading>) {
  return (
    <Cmdk.Loading
      className={cn(
        "flex items-center justify-center gap-2 px-3 py-6 text-sm text-fg-muted",
        className,
      )}
      {...props}
    >
      <SunSpinner size="sm" />
      {children}
    </Cmdk.Loading>
  );
}

export function CommandGroup({ className, ...props }: ComponentPropsWithoutRef<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Cmdk.Separator>) {
  return (
    <Cmdk.Separator className={cn("-mx-1.5 my-1 h-px bg-line-subtle", className)} {...props} />
  );
}

export interface CommandItemProps extends ComponentPropsWithoutRef<typeof Cmdk.Item> {
  icon?: ReactNode;
  shortcut?: string;
  /** Secondary text on the right (e.g. "Page 2"). */
  hint?: ReactNode;
}

export function CommandItem({
  className,
  icon,
  shortcut,
  hint,
  children,
  ...props
}: CommandItemProps) {
  return (
    <Cmdk.Item
      className={cn(
        menuItem,
        "h-9 data-[selected=true]:bg-fg/8 data-[selected=true]:text-fg data-[selected=true]:[&_svg]:text-fg data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="text-2xs text-fg-muted">{hint}</span> : null}
      {shortcut ? <Shortcut keys={shortcut} className="ml-2" /> : null}
    </Cmdk.Item>
  );
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  placeholder?: string;
  /** Global shortcut that toggles the palette (default `mod+k`; `null` disables). */
  shortcut?: string | null;
  /** Accessible title (visually hidden). */
  title?: string;
  /** Controlled search value. */
  search?: string;
  onSearchChange?: (value: string) => void;
  /** Footer hints. */
  footer?: ReactNode;
  /** Disable cmdk's built-in filtering (when results come from a server). */
  shouldFilter?: boolean;
}

/**
 * ⌘K / Ctrl+K command palette: a glass dialog near the top of the screen with a search field and
 * grouped, keyboard-navigable commands.
 */
export function CommandPalette({
  open,
  onOpenChange,
  children,
  placeholder = "Search commands, layers, templates…",
  shortcut = "mod+k",
  title = "Command palette",
  search,
  onSearchChange,
  footer,
  shouldFilter,
}: CommandPaletteProps) {
  const container = usePortalContainer();
  useHotkeys(shortcut ? { [shortcut]: () => onOpenChange(!open) } : {}, { allowInInputs: true });
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Overlay
          className={cn(layers.overlay, "dsn-fade fixed inset-0 bg-scrim backdrop-blur-[3px]")}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            layers.modal,
            "dsn-dialog fixed top-[14vh] left-1/2 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-panel border border-line-subtle bg-surface-1/95 shadow-dialog backdrop-blur-[20px] outline-none",
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <ModalLayerProvider>
            <Command shouldFilter={shouldFilter}>
              <CommandInput
                placeholder={placeholder}
                value={search}
                onValueChange={onSearchChange}
              />
              <CommandList>{children}</CommandList>
              {footer !== undefined ? (
                footer
              ) : (
                <div className="flex items-center gap-4 border-t border-line-subtle px-3.5 py-2 text-2xs text-fg-muted">
                  <span className="flex items-center gap-1.5">
                    <Shortcut keys="arrowup" /> <Shortcut keys="arrowdown" /> to navigate
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Shortcut keys="enter" /> to run
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <Shortcut keys="escape" /> to close
                  </span>
                </div>
              )}
            </Command>
          </ModalLayerProvider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ComboboxOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Extra search terms. */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value?: string | null;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: ReactNode;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  contentClassName?: string;
}

/** Searchable select: a trigger that opens a filterable list (type to narrow, Enter to pick). */
export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches",
  size = "md",
  disabled,
  "aria-label": ariaLabel,
  className,
  contentClassName,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const field = useFieldControlProps({ disabled });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={field.disabled}>
        <button
          type="button"
          role="combobox"
          id={field.id}
          aria-describedby={field["aria-describedby"]}
          aria-invalid={field["aria-invalid"]}
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            inputShellVariants({ size }),
            "cursor-pointer justify-between text-left data-[state=open]:border-transparent data-[state=open]:ring-2 data-[state=open]:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            focusRing,
            className,
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-2 truncate",
              !selected && "text-fg-placeholder",
            )}
          >
            {selected?.icon}
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="size-3.5! shrink-0 text-fg-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        flush
        align="start"
        className={cn("w-(--radix-popover-trigger-width) min-w-56", contentClassName)}
      >
        <Command>
          <div className="flex items-center gap-2 border-b border-line-subtle px-2.5">
            <Search className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
            <Cmdk.Input
              placeholder={searchPlaceholder}
              className="h-9 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-placeholder"
            />
          </div>
          <Cmdk.List className="max-h-64 overflow-y-auto p-1">
            <Cmdk.Empty className="px-2 py-5 text-center text-xs text-fg-muted">
              {emptyText}
            </Cmdk.Empty>
            {options.map((o) => (
              <Cmdk.Item
                key={o.value}
                value={`${o.label} ${o.value}`}
                keywords={o.keywords}
                disabled={o.disabled}
                onSelect={() => {
                  onValueChange?.(o.value);
                  setOpen(false);
                }}
                className={cn(
                  menuItem,
                  "data-[selected=true]:bg-fg/8 data-[selected=true]:text-fg data-[disabled=true]:opacity-40",
                )}
              >
                {o.icon}
                <span className="flex-1 truncate">{o.label}</span>
                {o.value === value ? (
                  <Check className="size-3.5! text-accent!" strokeWidth={2.5} />
                ) : null}
              </Cmdk.Item>
            ))}
          </Cmdk.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
