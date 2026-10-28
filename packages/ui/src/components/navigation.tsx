"use client";

import { Check, ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { focusRing } from "../lib/styles.ts";

// ---------------------------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------------------------

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
}

export interface BreadcrumbsProps extends ComponentPropsWithoutRef<"nav"> {
  items: BreadcrumbItem[];
  /** Collapse the middle when there are more items than this (keeps first and last two). */
  maxItems?: number;
  /** Render links with a custom component (e.g. Next `Link`) via `asChild`. */
  renderLink?: (item: BreadcrumbItem, children: ReactNode) => ReactNode;
}

/** Path navigation; the last item is the current page. */
export function Breadcrumbs({
  items,
  maxItems = 4,
  renderLink,
  className,
  ...props
}: BreadcrumbsProps) {
  const collapsed = items.length > maxItems;
  const visible: (BreadcrumbItem | "ellipsis")[] = collapsed
    ? [items[0] as BreadcrumbItem, "ellipsis", ...items.slice(-2)]
    : items;
  return (
    <nav aria-label="Breadcrumb" className={className} {...props}>
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {visible.map((item, i) => {
          const last = i === visible.length - 1;
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb order is positional
              key={i}
              className={cn("flex min-w-0 items-center gap-1", last ? "shrink" : "shrink-0")}
            >
              {item === "ellipsis" ? (
                <span
                  aria-label="More"
                  role="img"
                  className="grid size-6 place-items-center text-fg-muted"
                >
                  <MoreHorizontal className="size-4" />
                </span>
              ) : last ? (
                <span
                  aria-current="page"
                  className="flex min-w-0 items-center gap-1.5 truncate font-medium text-fg"
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </span>
              ) : (
                (renderLink?.(item, <CrumbInner item={item} />) ?? (
                  <a
                    href={item.href}
                    onClick={
                      item.onClick
                        ? (e) => {
                            if (!item.href) e.preventDefault();
                            item.onClick?.();
                          }
                        : undefined
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-[5px] px-1 text-fg-muted transition-colors hover:text-fg",
                      focusRing,
                    )}
                  >
                    <CrumbInner item={item} />
                  </a>
                ))
              )}
              {last ? null : <ChevronRight aria-hidden className="size-3.5 shrink-0 text-fg/30" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function CrumbInner({ item }: { item: BreadcrumbItem }) {
  return (
    <>
      {item.icon}
      <span className="max-w-40 truncate">{item.label}</span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------

/**
 * Page numbers to show: always first and last, `siblings` around the current page, and
 * `"ellipsis"` markers for gaps (never an ellipsis that hides a single page).
 */
export function paginationRange(
  page: number,
  pageCount: number,
  siblings = 1,
): (number | "ellipsis")[] {
  if (pageCount <= 0) return [];
  const total = siblings * 2 + 5;
  if (pageCount <= total) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const left = Math.max(page - siblings, 1);
  const right = Math.min(page + siblings, pageCount);
  const showLeft = left > 3;
  const showRight = right < pageCount - 2;
  if (!showLeft && showRight) {
    const count = 3 + siblings * 2;
    return [...Array.from({ length: count }, (_, i) => i + 1), "ellipsis", pageCount];
  }
  if (showLeft && !showRight) {
    const count = 3 + siblings * 2;
    return [1, "ellipsis", ...Array.from({ length: count }, (_, i) => pageCount - count + i + 1)];
  }
  return [
    1,
    "ellipsis",
    ...Array.from({ length: right - left + 1 }, (_, i) => left + i),
    "ellipsis",
    pageCount,
  ];
}

export interface PaginationProps extends Omit<ComponentPropsWithoutRef<"nav">, "onChange"> {
  /** 1-based current page. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  siblings?: number;
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  siblings = 1,
  className,
  ...props
}: PaginationProps) {
  const range = paginationRange(page, pageCount, siblings);
  const btn = cn(
    "inline-flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-control px-2 text-sm tabular-nums transition-colors disabled:pointer-events-none disabled:opacity-35",
    focusRing,
  );
  return (
    <nav aria-label="Pagination" className={cn("flex items-center gap-1", className)} {...props}>
      <button
        type="button"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        className={cn(btn, "text-fg-secondary hover:bg-fg/6 hover:text-fg")}
      >
        <ChevronLeft className="size-4" />
      </button>
      {range.map((p, i) =>
        p === "ellipsis" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: up to two positional ellipses
          <span key={`e${i}`} aria-hidden className="grid h-8 w-6 place-items-center text-fg-muted">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onPageChange(p)}
            className={cn(
              btn,
              p === page
                ? "bg-fg/10 font-medium text-fg"
                : "text-fg-secondary hover:bg-fg/6 hover:text-fg",
            )}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        aria-label="Next page"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        className={cn(btn, "text-fg-secondary hover:bg-fg/6 hover:text-fg")}
      >
        <ChevronRight className="size-4" />
      </button>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------------------------

export interface StepperStep {
  label: ReactNode;
  description?: ReactNode;
}

export interface StepperProps extends ComponentPropsWithoutRef<"ol"> {
  steps: StepperStep[];
  /** 0-based index of the current step; steps before it are complete. */
  current: number;
  orientation?: "horizontal" | "vertical";
  /** Make completed steps clickable. */
  onStepClick?: (index: number) => void;
}

/** Progress through a multi-step flow (onboarding, export wizard). */
export function Stepper({
  steps,
  current,
  orientation = "horizontal",
  onStepClick,
  className,
  ...props
}: StepperProps) {
  const horizontal = orientation === "horizontal";
  return (
    <ol
      className={cn("flex", horizontal ? "w-full items-start" : "flex-col gap-0", className)}
      {...props}
    >
      {steps.map((step, i) => {
        const state = i < current ? "complete" : i === current ? "current" : "upcoming";
        const clickable = state === "complete" && !!onStepClick;
        const Marker = clickable ? "button" : "span";
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
            key={i}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "relative flex",
              horizontal ? "flex-1 flex-col items-center text-center" : "gap-3 pb-6 last:pb-0",
            )}
          >
            {i < steps.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "absolute bg-line-subtle",
                  horizontal
                    ? "top-3.5 left-[calc(50%+18px)] h-px w-[calc(100%-36px)]"
                    : "top-8 bottom-1 left-3.5 w-px",
                  state === "complete" && "bg-accent",
                )}
              />
            ) : null}
            <Marker
              {...(clickable ? { type: "button" as const, onClick: () => onStepClick?.(i) } : {})}
              className={cn(
                "relative z-[1] grid size-7 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums transition-colors",
                state === "complete" && "border-transparent bg-accent-solid text-accent-ink",
                state === "current" && "border-accent bg-accent-tint text-accent-text",
                state === "upcoming" && "border-line bg-surface-2 text-fg-muted",
                clickable && cn("cursor-pointer", focusRing),
              )}
            >
              {state === "complete" ? (
                <Check className="size-3.5" strokeWidth={3} aria-hidden />
              ) : (
                i + 1
              )}
              <span className="sr-only">{state === "complete" ? " (complete)" : ""}</span>
            </Marker>
            <span className={cn("flex flex-col gap-0.5", horizontal ? "mt-2 px-2" : "pt-1")}>
              <span className={cn("text-sm", state === "upcoming" ? "text-fg-muted" : "text-fg")}>
                {step.label}
              </span>
              {step.description ? (
                <span className="text-xs text-fg-muted">{step.description}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A styled anchor (`asChild` to wrap router links). */
export function Link({
  asChild,
  className,
  ...props
}: ComponentPropsWithoutRef<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "a";
  return (
    <Comp
      className={cn(
        "rounded-[3px] text-accent-text underline decoration-accent/40 underline-offset-[3px] transition-colors hover:decoration-accent",
        focusRing,
        className,
      )}
      {...props}
    />
  );
}
