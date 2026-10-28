import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge taught about Desyn's custom theme keys. Without this, `text-display` would be
 * classified as a text color and dropped when merged with `text-fg`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "2xs",
        "md",
        "display",
        "display-lg",
        "title",
        "title-lg",
        "heading",
        "subhead",
        "body",
        "label",
      ],
      shadow: ["glow", "glow-lg", "card", "popover", "dialog", "page", "inset"],
      radius: ["control", "card", "panel", "pill"],
      tracking: ["label"],
      animate: [
        "spin-sun",
        "shimmer",
        "sun-pulse",
        "float-1",
        "float-2",
        "float-3",
        "morph-1",
        "morph-2",
        "morph-3",
        "orb-pulse",
        "fade-up",
        "indeterminate",
      ],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (last one wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
