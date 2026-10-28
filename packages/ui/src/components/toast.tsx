"use client";

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { type ReactNode, useSyncExternalStore } from "react";
import { cn } from "../lib/cn.ts";
import { layers } from "../lib/layers.ts";
import { SunSpinner } from "./spinner.tsx";

export type ToastVariant = "default" | "success" | "error" | "warning" | "info" | "loading";

export interface ToastOptions {
  /** Stable id to update or dismiss later (generated when omitted). */
  id?: string;
  description?: ReactNode;
  variant?: ToastVariant;
  /** Auto-dismiss after ms. `Infinity` keeps it until dismissed. Loading toasts never auto-dismiss. */
  duration?: number;
  /** One action button (e.g. "Undo"). */
  action?: { label: string; onClick: () => void; altText?: string };
}

export interface ToastRecord extends ToastOptions {
  id: string;
  title: ReactNode;
  variant: ToastVariant;
  open: boolean;
  createdAt: number;
}

type Listener = () => void;

let toasts: ToastRecord[] = [];
const listeners = new Set<Listener>();
let counter = 0;
const MAX_TOASTS = 4;

function emit() {
  for (const l of listeners) l();
}

function upsert(title: ReactNode, options: ToastOptions = {}): string {
  const id = options.id ?? `t${++counter}`;
  const existing = toasts.find((t) => t.id === id);
  const record: ToastRecord = {
    ...existing,
    ...options,
    id,
    title,
    variant: options.variant ?? "default",
    open: true,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  toasts = existing
    ? toasts.map((t) => (t.id === id ? record : t))
    : [...toasts, record].slice(-MAX_TOASTS);
  emit();
  return id;
}

/** Closes a toast (animates out), or all toasts when no id is given. */
function dismiss(id?: string) {
  toasts = toasts.map((t) => (id === undefined || t.id === id ? { ...t, open: false } : t));
  emit();
}

function remove(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/**
 * Shows a toast. Returns its id.
 * `toast("Saved")`, `toast.success("Exported", { description })`, `toast.promise(p, {...})`.
 */
export const toast = Object.assign(
  (title: ReactNode, options?: ToastOptions) => upsert(title, options),
  {
    success: (title: ReactNode, options?: Omit<ToastOptions, "variant">) =>
      upsert(title, { ...options, variant: "success" }),
    error: (title: ReactNode, options?: Omit<ToastOptions, "variant">) =>
      upsert(title, { ...options, variant: "error" }),
    warning: (title: ReactNode, options?: Omit<ToastOptions, "variant">) =>
      upsert(title, { ...options, variant: "warning" }),
    info: (title: ReactNode, options?: Omit<ToastOptions, "variant">) =>
      upsert(title, { ...options, variant: "info" }),
    loading: (title: ReactNode, options?: Omit<ToastOptions, "variant">) =>
      upsert(title, { ...options, variant: "loading" }),
    /** Loading toast that turns into success/error when the promise settles. */
    promise: <T,>(
      promise: Promise<T>,
      messages: {
        loading: ReactNode;
        success: ReactNode | ((value: T) => ReactNode);
        error: ReactNode | ((error: unknown) => ReactNode);
      },
    ): Promise<T> => {
      const id = upsert(messages.loading, { variant: "loading" });
      promise.then(
        (value) =>
          upsert(
            typeof messages.success === "function" ? messages.success(value) : messages.success,
            { id, variant: "success" },
          ),
        (error: unknown) =>
          upsert(typeof messages.error === "function" ? messages.error(error) : messages.error, {
            id,
            variant: "error",
          }),
      );
      return promise;
    },
    dismiss,
  },
);

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const getSnapshot = () => toasts;
// A stable empty list: React requires getServerSnapshot to return the same value on every call.
const NO_TOASTS: ToastRecord[] = [];
const getServerSnapshot = (): ToastRecord[] => NO_TOASTS;

/** Current toasts (for custom renderers). */
export function useToasts(): ToastRecord[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const ICONS: Record<ToastVariant, ReactNode> = {
  default: <span className="mt-1 size-2 rounded-full bg-accent" />,
  success: <CheckCircle2 className="size-4 text-success" />,
  error: <XCircle className="size-4 text-danger" />,
  warning: <AlertTriangle className="size-4 text-warning" />,
  info: <Info className="size-4 text-info" />,
  loading: <SunSpinner size="md" />,
};

export interface ToasterProps {
  /** Default auto-dismiss duration in ms. */
  duration?: number;
  /** Label for the region (announced to screen readers). */
  label?: string;
  className?: string;
}

/**
 * Renders toasts at the bottom center. Mount once (included in `DesynProvider`). F8 focuses the
 * region; swipe down or press Escape to dismiss; hovering pauses the timer.
 */
export function Toaster({
  duration = 5000,
  label = "Notifications ({hotkey})",
  className,
}: ToasterProps) {
  const items = useToasts();
  return (
    <ToastPrimitive.Provider swipeDirection="down" duration={duration} label="Notification">
      {items.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          open={t.open}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
          onAnimationEnd={() => {
            if (!t.open) remove(t.id);
          }}
          duration={t.variant === "loading" ? Number.POSITIVE_INFINITY : (t.duration ?? duration)}
          type={t.variant === "error" ? "foreground" : "background"}
          className={cn(
            "dsn-toast pointer-events-auto relative flex w-full items-start gap-3 rounded-card border border-line-subtle bg-glass py-3 pr-9 pl-3.5 text-fg shadow-popover backdrop-blur-[20px] backdrop-saturate-[1.2]",
            t.variant === "error" && "border-danger/30",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
            {ICONS[t.variant]}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <ToastPrimitive.Title className="text-sm font-medium text-fg">
              {t.title}
            </ToastPrimitive.Title>
            {t.description ? (
              <ToastPrimitive.Description className="text-xs text-fg-muted">
                {t.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          {t.action ? (
            <ToastPrimitive.Action
              altText={t.action.altText ?? t.action.label}
              onClick={t.action.onClick}
              className="shrink-0 cursor-pointer self-center rounded-[6px] px-2 py-1 text-xs font-medium text-accent-text transition-colors hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-ring"
            >
              {t.action.label}
            </ToastPrimitive.Action>
          ) : null}
          <ToastPrimitive.Close
            aria-label="Dismiss"
            className="absolute top-2.5 right-2.5 grid size-5 cursor-pointer place-items-center rounded-[5px] text-fg-muted transition-colors hover:bg-fg/8 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
          >
            <X className="size-3.5" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        label={label}
        className={cn(
          layers.toast,
          "fixed bottom-4 left-1/2 flex w-[min(400px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2 outline-none",
          className,
        )}
      />
    </ToastPrimitive.Provider>
  );
}
