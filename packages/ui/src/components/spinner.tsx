"use client";

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn.ts";

const SIZES = { xs: 12, sm: 14, md: 16, lg: 24, xl: 40 } as const;

export interface SunSpinnerProps extends Omit<ComponentPropsWithoutRef<"svg">, "children"> {
  /** Pixel size preset or explicit px. */
  size?: keyof typeof SIZES | number;
  /**
   * Accessible label. When set the spinner is announced as a status; leave it out when the
   * surrounding element already communicates loading (e.g. a button with `aria-busy`).
   */
  label?: string;
}

const RAYS = Array.from({ length: 8 }, (_, i) => i);

/**
 * Desyn's loading indicator: a small sun whose rays sweep around a steady core. Color follows
 * `currentColor` for the core and rays, so it works on sun buttons (ink) and on surfaces (accent).
 */
export function SunSpinner({ size = "md", label, className, ...props }: SunSpinnerProps) {
  const px = typeof size === "number" ? size : SIZES[size];
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 text-accent", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <g className="origin-center animate-spin-sun motion-reduce:animate-none">
        {RAYS.map((i) => (
          <line
            key={i}
            x1="12"
            y1="2.2"
            x2="12"
            y2="5.2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            opacity={0.18 + (i / (RAYS.length - 1)) * 0.82}
            transform={`rotate(${i * 45} 12 12)`}
          />
        ))}
      </g>
    </svg>
  );
}
