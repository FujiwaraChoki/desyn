"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** Fade-up on first view (Atmospheric Minimalism entrance: 0.8 s, ease-out, 80 ms stagger). */
export function Reveal({
  children,
  delay = 0,
  className,
  y = 24,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  y?: number;
  as?: "div" | "li" | "section" | "header";
}) {
  // The initial state must match the server render, so reduced motion changes the transition
  // (content appears at once, without travel) rather than skipping the initial state.
  const reduced = usePrefersReducedMotion();
  const Comp = motion[as];
  return (
    <Comp
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={reduced ? { duration: 0 } : { duration: 0.8, ease: [0.16, 1, 0.3, 1], delay }}
    >
      {children}
    </Comp>
  );
}
