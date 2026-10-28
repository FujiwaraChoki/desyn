"use client";

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn.ts";
import { layers } from "../lib/layers.ts";
import { IconButton } from "./button.tsx";
import { ModalLayerProvider, usePortalContainer } from "./portal.tsx";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const SIDE_CLASSES = {
  right: "inset-y-0 right-0 h-full w-[min(420px,100vw)] border-l",
  left: "inset-y-0 left-0 h-full w-[min(420px,100vw)] border-r",
  top: "inset-x-0 top-0 max-h-[85dvh] w-full border-b",
  bottom: "inset-x-0 bottom-0 max-h-[85dvh] w-full rounded-t-panel border-t",
} as const;

export interface SheetContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Edge the sheet slides from. `bottom` is the mobile drawer. */
  side?: keyof typeof SIDE_CLASSES;
  showClose?: boolean;
  closeLabel?: string;
  /** Show the grab handle on bottom drawers. */
  handle?: boolean;
}

/**
 * Edge-anchored modal panel (settings, mobile inspector, drawers). Same focus and Escape behaviour
 * as `Dialog`.
 */
export function SheetContent({
  side = "right",
  className,
  children,
  showClose = true,
  closeLabel = "Close",
  handle = side === "bottom",
  ...props
}: SheetContentProps) {
  const container = usePortalContainer();
  return (
    <DialogPrimitive.Portal container={container ?? undefined}>
      <DialogPrimitive.Overlay
        className={cn(layers.overlay, "dsn-fade fixed inset-0 bg-scrim backdrop-blur-[2px]")}
      />
      <DialogPrimitive.Content
        data-side={side}
        className={cn(
          layers.modal,
          "dsn-sheet fixed flex flex-col border-line-subtle bg-surface-1 text-fg shadow-dialog outline-none",
          SIDE_CLASSES[side],
          className,
        )}
        {...props}
      >
        {handle ? (
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-fg/20" />
        ) : null}
        <ModalLayerProvider>{children}</ModalLayerProvider>
        {showClose ? (
          <DialogPrimitive.Close asChild>
            <IconButton
              label={closeLabel}
              tooltip={false}
              size="sm"
              className="absolute top-3 right-3"
            >
              <X />
            </IconButton>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex flex-col gap-1 px-5 pt-5 pb-3 pr-12", className)} {...props} />;
}

export function SheetTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("font-serif text-[24px] leading-tight text-fg", className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-sm text-fg-muted", className)} {...props} />
  );
}

export function SheetBody({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 pb-5", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-line-subtle px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Sheet as Drawer,
  SheetBody as DrawerBody,
  SheetClose as DrawerClose,
  SheetContent as DrawerContent,
  SheetDescription as DrawerDescription,
  SheetFooter as DrawerFooter,
  SheetHeader as DrawerHeader,
  SheetTitle as DrawerTitle,
  SheetTrigger as DrawerTrigger,
};
