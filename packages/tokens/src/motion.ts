import type { Transition, Variants } from "motion/react";
import { durations, easings, stagger } from "./timing.ts";

export { durations, easings, stagger };

/**
 * Motion presets for the `motion` library (`motion/react`). All presets are plain objects so they
 * can be shared between components and pages. Wrap the app in `<MotionConfig reducedMotion="user">`
 * (done by `@desyn/ui`'s `DesynProvider`) so transforms are dropped for users who prefer reduced motion.
 */

/** Spring for panels, sheets and drawers (stiffness 300, damping 30). */
export const springPanel: Transition = { type: "spring", stiffness: 300, damping: 30, mass: 1 };
/** Snappier spring for small things: toggles, thumbs, selection indicators. */
export const springSnappy: Transition = { type: "spring", stiffness: 520, damping: 38, mass: 0.8 };
/** Soft spring for large, slow surfaces (hero cards, page transitions). */
export const springGentle: Transition = { type: "spring", stiffness: 160, damping: 26, mass: 1 };

/** 0.2 s ease-out: hovers and color changes. */
export const tweenFast: Transition = { duration: durations.fast, ease: easings.out };
/** 0.5 s ease-out: entrances. */
export const tweenNormal: Transition = { duration: durations.normal, ease: easings.out };
/** 0.8 s ease-out: hero entrances. */
export const tweenSlow: Transition = { duration: durations.slow, ease: easings.out };

/** Parent that staggers children by 80 ms. Use with `initial="hidden" animate="visible"`. */
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: stagger, delayChildren: 0.04 } },
};

/** Fade up 20 px (0.8 s). */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: tweenSlow },
};

/** Plain fade (0.5 s). */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: tweenNormal },
};

/** Scale in from 0.9 (0.6 s) for CTAs and hero objects. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.6, ease: easings.out } },
};

/** Per-character heading reveal; put on each `<motion.span>` inside a `staggerContainer`. */
export const charReveal: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: durations.normal, ease: easings.out } },
};

/** Floating surfaces (menus, popovers): quick scale + fade from the trigger side. */
export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: easings.out } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: easings.inOut } },
};

/** Dialogs: rise and settle with the panel spring. */
export const dialogIn: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: 12 },
  visible: { opacity: 1, scale: 1, y: 0, transition: springPanel },
  exit: { opacity: 0, scale: 0.98, y: 6, transition: { duration: 0.14, ease: easings.inOut } },
};

/** Side the sheet enters from. */
export type SheetSide = "left" | "right" | "top" | "bottom";

/** Sheets/drawers sliding in from an edge with the panel spring. */
export function slideIn(side: SheetSide): Variants {
  const offset = side === "left" || side === "top" ? "-100%" : "100%";
  const at = (value: string | number) =>
    side === "left" || side === "right" ? { x: value } : { y: value };
  return {
    hidden: at(offset),
    visible: { ...at(0), transition: springPanel },
    exit: { ...at(offset), transition: { duration: 0.22, ease: easings.inOut } },
  };
}

/** The "sunrise" sweep played when the AI agent finishes editing a layer. */
export const sunrise: Variants = {
  hidden: { opacity: 0, backgroundPosition: "0% 100%" },
  visible: {
    opacity: [0, 1, 0],
    backgroundPosition: ["0% 100%", "0% 0%", "0% 0%"],
    transition: { duration: 1.2, ease: easings.out, times: [0, 0.45, 1] },
  },
};
