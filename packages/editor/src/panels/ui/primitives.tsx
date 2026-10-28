"use client";

import {
  cn,
  EmptyState,
  IconButton,
  Input,
  ProBadge,
  Skeleton,
  Slider,
  type SliderProps,
  Tooltip,
} from "@desyn/ui";
import { Search, X } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Building blocks shared by the rail flyouts and the inspector: a scroll body, titled sections, a search
 * field, tile grids, rows with a label column, skeletons and empty states. Dense editor chrome (12-13 px sans,
 * 4 px half steps), sun accent only on what is active.
 */

export function PanelBody({
  children,
  className,
  ref,
}: {
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className={cn(
        "h-full min-h-0 overflow-y-auto overscroll-contain px-3 pb-6 [scrollbar-gutter:stable]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelSection({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2 pt-4", className)}>
      {title || action ? (
        <div className="flex min-h-6 items-center justify-between gap-2">
          {title ? (
            <h3 className="text-xs font-medium tracking-[0.01em] text-fg-secondary">{title}</h3>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Search input with a clear button; `onSubmit` fires on Enter. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  onSubmit,
  autoFocus,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  onSubmit?: (v: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <Input
      ref={ref}
      size="sm"
      type="search"
      value={value}
      aria-label={label}
      placeholder={placeholder}
      leading={<Search className="size-3.5" />}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") onSubmit?.(value);
        if (e.key === "Escape" && value) {
          e.stopPropagation();
          onChange("");
        }
      }}
      trailing={
        value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onChange("");
              ref.current?.focus();
            }}
            className="grid size-5 cursor-pointer place-items-center rounded-[4px] text-fg-muted hover:bg-fg/8 hover:text-fg"
          >
            <X className="size-3" />
          </button>
        ) : null
      }
      className={cn("w-full [&_input::-webkit-search-cancel-button]:hidden", className)}
    />
  );
}

/** Debounced copy of a value (search fields). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Responsive grid of tiles (`min` px columns). */
export function TileGrid({
  children,
  min = 64,
  gap = 6,
  className,
}: {
  children: ReactNode;
  min?: number;
  gap?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("grid", className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap }}
    >
      {children}
    </div>
  );
}

export interface TileProps extends Omit<ComponentPropsWithoutRef<"button">, "title"> {
  label: string;
  /** Show the label under the preview. */
  caption?: boolean;
  /** Plan-gated: shows a PRO pill. */
  pro?: boolean;
  /** Aspect ratio of the preview box (w / h). */
  ratio?: number;
  busy?: boolean;
}

/** Square-ish clickable preview; the fill lightens on hover. */
export function Tile({
  label,
  caption = false,
  pro = false,
  ratio = 1,
  busy = false,
  className,
  children,
  ...props
}: TileProps) {
  const tile = (
    <button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      className={cn(
        "group/tile relative flex w-full min-w-0 cursor-pointer flex-col gap-1.5 rounded-[10px] text-left outline-none",
        "focus-visible:[&>[data-preview]]:ring-2 focus-visible:[&>[data-preview]]:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        data-preview=""
        className={cn(
          "relative grid w-full place-items-center overflow-hidden rounded-[10px] bg-surface-2 text-fg-secondary transition-[transform,background-color] duration-200 ease-out",
          "group-hover/tile:bg-surface-3 group-active/tile:scale-[0.98]",
        )}
        style={{ aspectRatio: String(ratio) }}
      >
        {children}
        {busy ? (
          <span className="absolute inset-0 grid place-items-center bg-surface-1/60 backdrop-blur-[2px]">
            <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
          </span>
        ) : null}
        {pro ? <ProBadge className="absolute top-1.5 right-1.5 scale-90" /> : null}
      </span>
      {caption ? (
        <span className="truncate px-0.5 text-2xs text-fg-muted group-hover/tile:text-fg-secondary">
          {label}
        </span>
      ) : null}
    </button>
  );
  return caption ? tile : <Tooltip content={label}>{tile}</Tooltip>;
}

export function TileSkeletons({ count = 9, ratio = 1 }: { count?: number; ratio?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => `skeleton-${i}`).map((id) => (
        <Skeleton
          key={id}
          className="w-full rounded-[10px]"
          style={{ aspectRatio: String(ratio) }}
        />
      ))}
    </>
  );
}

/** Calm empty state sized for a 320 px flyout. */
export function PanelEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      size="sm"
      icon={icon}
      title={title}
      description={description}
      action={action}
      className="px-2 py-10"
    />
  );
}

/** Horizontal chips (filters, categories); scrolls sideways when they overflow. */
export function ChipRow<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  label: string;
}) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = options[(index + delta + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const buttons = e.currentTarget.parentElement?.querySelectorAll("button");
    (
      buttons?.[(index + delta + options.length) % options.length] as HTMLButtonElement | undefined
    )?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="-mx-3 flex gap-1 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]"
    >
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: see the group above
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onKeyDown={(e) => move(e, i)}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 shrink-0 cursor-pointer rounded-full px-3 text-xs whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            o.value === value ? "bg-fg/10 text-fg" : "text-fg-muted hover:bg-fg/6 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Inspector row: a fixed label column and controls. */
export function Row({
  label,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div
      className={cn("grid min-h-8 grid-cols-[72px_minmax(0,1fr)] items-center gap-2", className)}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className="truncate text-xs text-fg-muted">
          {label}
        </label>
      ) : (
        <span className="truncate text-xs text-fg-muted">{label}</span>
      )}
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** Inspector section with a title and optional header actions (add / remove buttons). */
export function InspectorSection({
  title,
  actions,
  children,
  className,
  empty,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Section with no rows yet: only the header shows. */
  empty?: boolean;
}) {
  return (
    <section className={cn("border-b border-line-subtle px-3 py-2.5 last:border-b-0", className)}>
      <div className="flex h-7 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-fg-secondary">{title}</h3>
        {actions ? <div className="-mr-1 flex items-center gap-0.5">{actions}</div> : null}
      </div>
      {empty ? null : <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>}
    </section>
  );
}

/** Small icon button for section headers and rows. */
export function MiniButton({
  label,
  onClick,
  children,
  active,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <IconButton
      label={label}
      size="xs"
      variant="ghost"
      {...(active !== undefined ? { active } : {})}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}

/** "Load more" footer for paginated grids (also triggered when it scrolls into view). */
export function LoadMore({
  onLoad,
  loading,
  visible,
}: {
  onLoad: () => void;
  loading: boolean;
  visible: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !visible || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoad();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [onLoad, visible]);
  if (!visible && !loading) return null;
  return (
    <div ref={ref} className="flex justify-center py-3">
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className="cursor-pointer rounded-full px-3 py-1 text-xs text-fg-muted hover:bg-fg/6 hover:text-fg disabled:cursor-default"
      >
        {loading ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

/**
 * Slider for values around a neutral middle (image adjustments -100..+100, text curve): the sun fill
 * grows from the zero point towards the thumb instead of from the left edge, so "no change" reads as an
 * empty track rather than as half of something.
 */
export function CenteredSlider({
  min = -100,
  max = 100,
  origin = 0,
  value,
  className,
  ...props
}: SliderProps & { origin?: number }) {
  const span = Math.max(max - min, 1e-9);
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100));
  const zero = pct(origin);
  const at = pct(value?.[0] ?? origin);
  const thumb = props.size === "md" ? 14 : 12;
  return (
    <div className={cn("relative flex w-full min-w-0 items-center", className)}>
      {/* Own track + fill (inset by half a thumb, where Radix keeps the thumb centers). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2"
        style={{ paddingLeft: thumb / 2, paddingRight: thumb / 2 }}
      >
        <span className="relative block h-full rounded-full bg-fg/12">
          <span
            className="absolute top-1/2 h-[7px] w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg/25"
            style={{ left: `${zero}%` }}
          />
          <span
            className="absolute h-full rounded-full bg-accent"
            style={{ left: `${Math.min(zero, at)}%`, width: `${Math.abs(at - zero)}%` }}
          />
        </span>
      </span>
      <Slider
        min={min}
        max={max}
        {...(value ? { value } : {})}
        {...props}
        className="[&>span:first-child]:bg-transparent [&>span:first-child>span]:hidden"
      />
    </div>
  );
}
