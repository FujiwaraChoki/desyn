"use client";

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn.ts";

// ---------------------------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------------------------

export interface SunMarkProps extends Omit<ComponentPropsWithoutRef<"svg">, "children"> {
  size?: number;
  /** Accessible name; omit when next to the wordmark. */
  title?: string;
}

/**
 * The Desyn mark: two print crop corners around the sun, on a 48-unit grid. The corners take the
 * text colour and the sun the accent, so the mark follows the theme.
 */
export function SunMark({ size = 20, title, className, ...props }: SunMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      {...props}
    >
      <path
        d="M6 17V6h11M31 42h11V31"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      <circle cx="24" cy="24" r="8.5" fill="var(--accent-solid)" />
    </svg>
  );
}

export interface LogoProps extends ComponentPropsWithoutRef<"span"> {
  /** `full` = sun + wordmark, `mark` = sun only, `wordmark` = text only. */
  variant?: "full" | "mark" | "wordmark";
  /** Height of the wordmark in px (the mark scales with it). */
  size?: number;
}

/** "desyn" in Instrument Serif with the sun mark. Accessible name: "Desyn". */
export function Logo({ variant = "full", size = 24, className, ...props }: LogoProps) {
  return (
    <span
      role="img"
      aria-label="Desyn"
      className={cn("inline-flex items-center gap-[0.28em] text-fg select-none", className)}
      style={{ fontSize: size }}
      {...props}
    >
      {variant !== "wordmark" ? <SunMark size={Math.round(size * 1.15)} /> : null}
      {variant !== "mark" ? (
        <span
          aria-hidden
          className="font-serif leading-none tracking-[-0.01em]"
          style={{ fontSize: size * 1.05 }}
        >
          desyn
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Atmosphere
// ---------------------------------------------------------------------------------------------

export interface OrbsProps extends ComponentPropsWithoutRef<"div"> {
  /** Overall strength multiplier (1 = design-system default). */
  intensity?: number;
  /** Scale orb sizes for small containers (1 = 500/600/400 px). */
  scale?: number;
}

/**
 * Three blurred sun orbs that float and morph slowly behind content (Akatsuki atmosphere).
 * Decorative and pointer-transparent; the parent should be `relative overflow-hidden`.
 * Motion stops under `prefers-reduced-motion`.
 */
export function Orbs({ intensity = 1, scale = 1, className, style, ...props }: OrbsProps) {
  const orb = (cx: number, cy: number, mid: number) =>
    `radial-gradient(circle at ${cx}% ${cy}%, var(--accent-solid) 0%, rgb(var(--accent-solid-rgb) / ${mid}) 30%, transparent 70%)`;
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{ ...style, opacity: intensity }}
      {...props}
    >
      <div
        className="absolute animate-float-1 blur-[80px] will-change-transform motion-reduce:animate-none"
        style={{
          top: "-10%",
          right: "-5%",
          width: 500 * scale,
          height: 500 * scale,
          opacity: "var(--orb-opacity)",
        }}
      >
        <div
          className="size-full animate-morph-1 motion-reduce:animate-none"
          style={{ background: orb(30, 40, 0.6) }}
        />
      </div>
      <div
        className="absolute animate-float-2 blur-[80px] will-change-transform motion-reduce:animate-none"
        style={{
          bottom: "-15%",
          left: "-10%",
          width: 600 * scale,
          height: 600 * scale,
          opacity: "var(--orb-opacity)",
        }}
      >
        <div
          className="size-full animate-morph-2 motion-reduce:animate-none"
          style={{ background: orb(60, 50, 0.5) }}
        />
      </div>
      <div
        className="absolute animate-float-3 will-change-transform motion-reduce:animate-none"
        style={{
          top: "40%",
          left: `calc(50% - ${200 * scale}px)`,
          width: 400 * scale,
          height: 400 * scale,
          opacity: "calc(var(--orb-opacity) * 0.9)",
        }}
      >
        <div
          className="size-full animate-morph-3 blur-[80px] motion-reduce:animate-none"
          style={{ background: orb(50, 30, 0.7) }}
        />
      </div>
    </div>
  );
}

export interface SunGlowProps extends ComponentPropsWithoutRef<"div"> {
  /** Width/height of the glow ellipse in px. */
  width?: number;
  height?: number;
  /** Peak opacity of the core (default 0.15, Akatsuki backdrop). */
  strength?: number;
}

/** Soft elliptical sun glow placed behind a heading or hero object. */
export function SunGlow({
  width = 800,
  height = 400,
  strength = 0.15,
  className,
  style,
  ...props
}: SunGlowProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-1/2 left-1/2 -translate-1/2 rounded-full blur-[60px]",
        className,
      )}
      style={{
        width,
        height,
        background: `radial-gradient(ellipse, rgb(var(--accent-rgb) / ${strength}) 0%, rgb(var(--accent-rgb) / ${strength / 2}) 40%, transparent 70%)`,
        ...style,
      }}
      {...props}
    />
  );
}
