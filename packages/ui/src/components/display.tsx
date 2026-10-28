"use client";

import { chartPalette } from "@desyn/tokens";
import type { VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, Sun, XCircle } from "lucide-react";
import {
  Avatar as AvatarPrimitive,
  Progress as ProgressPrimitive,
  VisuallyHidden as VisuallyHiddenPrimitive,
} from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { badgeVariants } from "../lib/variants.ts";
import { Tooltip } from "./tooltip.tsx";

// ---------------------------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------------------------

const AVATAR_SIZES = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-14 text-lg",
} as const;

/** Up to two initials from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
  return (first + last).toUpperCase();
}

/** Deterministic warm color for a name (fallback avatar fill). */
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = chartPalette.warm.slice(0, 5);
  return palette[h % palette.length] ?? chartPalette.warm[0];
}

export interface AvatarProps
  extends Omit<ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>, "children"> {
  name: string;
  src?: string | null;
  size?: keyof typeof AVATAR_SIZES;
  /** Presence ring color (the collaborator's cursor color). */
  ring?: string;
  /** Presence dot. */
  status?: "online" | "away" | "offline";
}

/** Circular avatar with initials fallback, optional presence ring (collaborator color) and status dot. */
export function Avatar({
  name,
  src,
  size = "md",
  ring,
  status,
  className,
  style,
  ...props
}: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative inline-flex shrink-0 select-none rounded-full",
        AVATAR_SIZES[size],
        className,
      )}
      style={{
        ...(ring ? { boxShadow: `0 0 0 1.5px var(--background), 0 0 0 3px ${ring}` } : null),
        ...style,
      }}
      {...props}
    >
      {src ? (
        <AvatarPrimitive.Image
          src={src}
          alt={name}
          className="size-full rounded-full object-cover"
        />
      ) : null}
      <AvatarPrimitive.Fallback
        delayMs={src ? 300 : 0}
        className="flex size-full items-center justify-center rounded-full font-semibold text-[#1a1205]"
        style={{ background: nameColor(name) }}
        aria-label={name}
        role="img"
      >
        {initials(name)}
      </AvatarPrimitive.Fallback>
      {status ? (
        <span
          role="img"
          aria-label={status}
          className={cn(
            "absolute -right-px -bottom-px size-[30%] min-h-2 min-w-2 rounded-full ring-2 ring-background",
            status === "online" ? "bg-success" : status === "away" ? "bg-accent" : "bg-fg/40",
          )}
        />
      ) : null}
    </AvatarPrimitive.Root>
  );
}

export interface AvatarStackProps extends ComponentPropsWithoutRef<"div"> {
  people: {
    id: string;
    name: string;
    src?: string | null;
    color?: string;
    status?: AvatarProps["status"];
  }[];
  max?: number;
  size?: AvatarProps["size"];
}

/** Overlapping avatars (collaborators in the top bar) with tooltips and a "+N" overflow chip. */
export function AvatarStack({
  people,
  max = 4,
  size = "sm",
  className,
  ...props
}: AvatarStackProps) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics
    <div
      role="group"
      aria-label={`${people.length} collaborators`}
      className={cn("flex items-center -space-x-0.5", className)}
      {...props}
    >
      {shown.map((p) => (
        <Tooltip key={p.id} content={p.name}>
          <span
            className={cn(
              "relative rounded-full transition-transform duration-200 hover:z-10 hover:-translate-y-0.5",
              !p.color && "ring-2 ring-surface-1",
            )}
          >
            <Avatar name={p.name} src={p.src} size={size} ring={p.color} status={p.status} />
          </span>
        </Tooltip>
      ))}
      {extra > 0 ? (
        <span
          className={cn(
            "relative flex items-center justify-center rounded-full bg-surface-3 font-medium text-fg-secondary ring-2 ring-surface-1",
            AVATAR_SIZES[size],
          )}
          role="img"
          aria-label={`${extra} more`}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------------------------

export interface BadgeProps
  extends ComponentPropsWithoutRef<"span">,
    VariantProps<typeof badgeVariants> {
  /** Leading status dot. */
  dot?: boolean;
}

export function Badge({ tone, size, dot, className, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/** The "Pro" pill: sun gradient with ink text and a soft glow. */
export function ProBadge({
  className,
  children = "Pro",
  ...props
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-(image:--sun-gradient) px-2 text-[11px] font-semibold text-accent-ink shadow-[0_0_14px_-4px_var(--accent-glow),inset_0_1px_0_rgb(255_255_255/0.35)]",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Skeleton, Progress
// ---------------------------------------------------------------------------------------------

/** Loading placeholder with a warm shimmer (static under reduced motion). */
export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden
      className={cn("dsn-shimmer animate-shimmer rounded-[6px]", className)}
      {...props}
    />
  );
}

export interface ProgressProps
  extends Omit<ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>, "value"> {
  /** 0..max; `null` for indeterminate. */
  value: number | null;
  max?: number;
  size?: "sm" | "md";
  label?: string;
}

/** Linear progress with a glowing sun fill; indeterminate when `value` is null. */
export function Progress({
  value,
  max = 100,
  size = "md",
  label,
  className,
  ...props
}: ProgressProps) {
  const pct = value === null ? null : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <ProgressPrimitive.Root
      value={value}
      max={max}
      aria-label={label}
      className={cn(
        "relative w-full overflow-hidden rounded-full bg-fg/10",
        size === "sm" ? "h-1" : "h-1.5",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full rounded-full bg-accent transition-[width] duration-500 ease-out",
          pct === null &&
            "w-full origin-left animate-indeterminate motion-reduce:w-2/5 motion-reduce:animate-none",
        )}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

export interface CircularProgressProps extends Omit<ComponentPropsWithoutRef<"svg">, "children"> {
  value: number | null;
  max?: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  /** Show the percentage in the middle (sizes >= 32). */
  showValue?: boolean;
}

/** Ring progress; indeterminate spins a partial arc. */
export function CircularProgress({
  value,
  max = 100,
  size = 32,
  strokeWidth = 3,
  label,
  showValue = false,
  className,
  ...props
}: CircularProgressProps) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const pct = value === null ? null : Math.min(1, Math.max(0, value / max));
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value ?? undefined}
        className={cn("-rotate-90", pct === null && "animate-spin-sun", className)}
        {...props}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line-subtle)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={pct === null ? c * 0.7 : c * (1 - pct)}
          className="transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      {showValue && pct !== null && size >= 32 ? (
        <span className="absolute inset-0 flex items-center justify-center font-sans text-[10px] font-medium tabular-nums text-fg">
          {Math.round(pct * 100)}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Card, EmptyState, Callout
// ---------------------------------------------------------------------------------------------

export interface CardProps extends ComponentPropsWithoutRef<"div"> {
  /** Sun-tinted soft shadow (Akatsuki card glow). */
  glow?: boolean;
  /** Hover lift for clickable cards. */
  interactive?: boolean;
}

export function Card({ glow, interactive, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-line-subtle bg-surface-1 text-fg",
        glow && "shadow-card",
        interactive &&
          "cursor-pointer transition-[border-color,transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:border-line hover:shadow-card",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentPropsWithoutRef<"h3">) {
  return (
    <h3
      className={cn("font-serif text-xl leading-tight font-normal text-fg", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  return <p className={cn("text-sm text-fg-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("flex items-center gap-2 border-t border-line-subtle px-5 py-3", className)}
      {...props}
    />
  );
}

export interface EmptyStateProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  icon?: ReactNode;
  /** One short line ("No designs yet"). */
  title: ReactNode;
  description?: ReactNode;
  /** One clear action. */
  action?: ReactNode;
  size?: "sm" | "md";
}

/** Quiet empty state: muted icon, one line of title, one sentence and one action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = "md",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "md" ? "gap-3 px-6 py-12" : "gap-2 px-4 py-8",
        className,
      )}
      {...props}
    >
      {icon ? <div className="text-fg-muted [&_svg]:size-5">{icon}</div> : null}
      <div className="flex max-w-sm flex-col gap-1">
        <h3
          className={cn(
            "font-medium text-fg [&_em]:not-italic",
            size === "md" ? "text-base" : "text-sm",
          )}
        >
          {title}
        </h3>
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

const CALLOUT_ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  accent: Sun,
} as const;

export interface CalloutProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  tone?: keyof typeof CALLOUT_ICONS;
  title?: ReactNode;
  icon?: ReactNode | false;
  /** Trailing action (button/link). */
  action?: ReactNode;
}

/** Inline message block. `danger` is announced as an alert; others are notes. */
export function Callout({
  tone = "info",
  title,
  icon,
  action,
  className,
  children,
  ...props
}: CalloutProps) {
  const Icon = CALLOUT_ICONS[tone];
  const toneClass = {
    info: "bg-info/8 [&_[data-callout-icon]]:text-info",
    success: "bg-success/8 [&_[data-callout-icon]]:text-success",
    warning: "bg-warning/8 [&_[data-callout-icon]]:text-warning",
    danger: "bg-danger/8 [&_[data-callout-icon]]:text-danger",
    accent: "bg-accent-wash [&_[data-callout-icon]]:text-accent",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-3 rounded-card px-3.5 py-3 text-sm",
        toneClass,
        className,
      )}
      {...props}
    >
      {icon === false ? null : (
        <span data-callout-icon="" className="mt-px shrink-0 [&_svg]:size-4">
          {icon ?? <Icon />}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className="text-fg-secondary">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Typography & VisuallyHidden
// ---------------------------------------------------------------------------------------------

export interface HeadingProps extends ComponentPropsWithoutRef<"h2"> {
  as?: "h1" | "h2" | "h3" | "h4";
  /** display 80/120, title 48/64, heading 28, subhead 20 (Instrument Serif). */
  size?: "display" | "title" | "heading" | "subhead";
  /** Sun-colored with a soft glow (Akatsuki display rule). */
  accent?: boolean;
}

/** Serif heading. Emphasis comes from size, color and `<em>` (italic), never bold. */
export function Heading({
  as: Tag = "h2",
  size = "heading",
  accent,
  className,
  ...props
}: HeadingProps) {
  return (
    <Tag
      className={cn(
        "font-serif font-normal text-balance [&_em]:italic",
        size === "display" && "text-display md:text-display-lg",
        size === "title" && "text-title md:text-title-lg",
        size === "heading" && "text-heading",
        size === "subhead" && "text-subhead",
        accent ? "text-accent" : "text-fg",
        className,
      )}
      {...props}
    />
  );
}

/** Small muted label above a heading or group (sentence case, normal tracking). */
export function Eyebrow({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return <span className={cn("text-2xs font-medium text-fg-muted", className)} {...props} />;
}

/** Content hidden visually but read by screen readers. */
export const VisuallyHidden = VisuallyHiddenPrimitive.Root;
