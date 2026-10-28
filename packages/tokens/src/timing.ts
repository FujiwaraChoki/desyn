/** A cubic-bezier as four control values. */
export type CubicBezier = readonly [number, number, number, number];

/** Easing curves. `out` is expo-like and is the default for every entrance and hover. */
export const easings = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
  in: [0.7, 0, 0.84, 0],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, CubicBezier>;

/** Durations in seconds (motion's unit). */
export const durations = {
  instant: 0.1,
  fast: 0.2,
  normal: 0.5,
  slow: 0.8,
} as const;

/** Stagger between siblings in seconds (80 ms). */
export const stagger = 0.08;

/** Tooltip open delay in ms. */
export const tooltipDelay = 400;

/** Background orb float/morph cycle lengths in seconds (15-30 s range). */
export const orbDurations = { float: [25, 30, 20], morph: [18, 22, 15], pulse: 8 } as const;

/** `cubic-bezier(...)` CSS string for a bezier tuple. */
export function cssBezier(bezier: CubicBezier): string {
  return `cubic-bezier(${bezier.join(", ")})`;
}
