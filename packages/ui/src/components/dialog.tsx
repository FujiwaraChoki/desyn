"use client";

import { X } from "lucide-react";
import { AlertDialog as AlertDialogPrimitive, Dialog as DialogPrimitive } from "radix-ui";
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { layers } from "../lib/layers.ts";
import { buttonVariants } from "../lib/variants.ts";
import { IconButton } from "./button.tsx";
import { ModalLayerProvider, usePortalContainer } from "./portal.tsx";

const overlayClass = cn(layers.overlay, "dsn-fade fixed inset-0 bg-scrim backdrop-blur-[3px]");

const contentBase = cn(
  layers.modal,
  "dsn-dialog fixed top-1/2 left-1/2 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-1/2 flex-col overflow-hidden",
  "rounded-panel border border-line-subtle bg-surface-1 text-fg shadow-dialog outline-none",
);

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  size?: keyof typeof SIZES;
  /** Show the top-right close button (default true). */
  showClose?: boolean;
  /** Label for the close button. */
  closeLabel?: string;
}

/**
 * Modal dialog surface: scrim + centered panel that rises in on the panel spring curve. Focus is
 * trapped, Escape closes, and the title/description are wired for screen readers.
 */
export function DialogContent({
  className,
  children,
  size = "md",
  showClose = true,
  closeLabel = "Close",
  ...props
}: DialogContentProps) {
  const container = usePortalContainer();
  return (
    <DialogPrimitive.Portal container={container ?? undefined}>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content className={cn(contentBase, SIZES[size], className)} {...props}>
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

/** Title + description block at the top of a dialog. */
export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex flex-col gap-1.5 px-6 pt-6 pb-4 pr-12", className)} {...props} />;
}

/** Dialog title in Instrument Serif. */
export function DialogTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "font-serif text-[26px] leading-[1.15] font-normal tracking-[-0.01em] text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-sm text-fg-muted", className)} {...props} />
  );
}

/** Scrollable middle section. */
export function DialogBody({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 pb-2", className)} {...props} />;
}

/** Action row; primary action goes last (right). */
export function DialogFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-line-subtle bg-fg/[0.02] px-6 py-4 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// AlertDialog: in-page confirmation (never `window.confirm`)
// ---------------------------------------------------------------------------------------------

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export function AlertDialogContent({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>) {
  const container = usePortalContainer();
  return (
    <AlertDialogPrimitive.Portal container={container ?? undefined}>
      <AlertDialogPrimitive.Overlay className={overlayClass} />
      <AlertDialogPrimitive.Content className={cn(contentBase, SIZES.sm, className)} {...props}>
        <ModalLayerProvider>{children}</ModalLayerProvider>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("font-serif text-[24px] leading-[1.2] font-normal text-fg", className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-sm text-fg-muted", className)}
      {...props}
    />
  );
}

export interface AlertDialogActionProps
  extends ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> {
  tone?: "primary" | "danger";
}

export function AlertDialogAction({
  className,
  tone = "primary",
  ...props
}: AlertDialogActionProps) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants({ variant: tone, size: "md" }), className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "ghost", size: "md" }), className)}
      {...props}
    />
  );
}

/** Options for `useConfirm()`. */
export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` styles the confirm button red (deleting, discarding). */
  tone?: "primary" | "danger";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Hosts the app-wide confirmation dialog used by `useConfirm()`. Included in `DesynProvider`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setState({ ...options, open: true });
    });
  }, []);

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState((s) => (s ? { ...s, open: false } : s));
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={state?.open ?? false} onOpenChange={(open) => !open && settle(false)}>
        {state ? (
          <AlertDialogContent>
            <div className="flex flex-col gap-2 px-6 pt-6 pb-5">
              <AlertDialogTitle>{state.title}</AlertDialogTitle>
              {state.description ? (
                <AlertDialogDescription>{state.description}</AlertDialogDescription>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-line-subtle bg-fg/[0.02] px-6 py-4">
              <AlertDialogCancel onClick={() => settle(false)}>
                {state.cancelLabel ?? "Cancel"}
              </AlertDialogCancel>
              <AlertDialogAction tone={state.tone} onClick={() => settle(true)}>
                {state.confirmLabel ?? "Confirm"}
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

/**
 * Promise-based in-page confirmation: `if (await confirm({ title: "Delete page?", tone: "danger" }))`.
 * Requires `ConfirmProvider` (part of `DesynProvider`).
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx)
    throw new Error("useConfirm must be used inside <ConfirmProvider> (or <DesynProvider>).");
  return ctx;
}
