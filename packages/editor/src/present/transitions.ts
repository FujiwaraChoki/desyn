import type { TransitionKind } from "./timeline.ts";

/**
 * Slide transitions (DOCUMENT_MODEL `PageNode.transition`) as Web Animations between a snapshot of the
 * outgoing slide (an <img> above the stage) and the stage that already shows the incoming slide.
 */

export interface TransitionArgs {
  kind: TransitionKind;
  durationMs: number;
  /** 1 = forward (next), -1 = back: slides and pushes come from the other side. */
  direction: 1 | -1;
  incoming: HTMLElement | null;
  outgoing: HTMLElement | null;
}

const EASE = "cubic-bezier(.16,1,.3,1)";
const EASE_IN_OUT = "cubic-bezier(.65,0,.35,1)";

export interface TransitionFrames {
  incoming: Keyframe[] | null;
  outgoing: Keyframe[] | null;
  easing: string;
}

/** Keyframes of a transition (pure; unit tested). */
export function transitionFrames(kind: TransitionKind, direction: 1 | -1): TransitionFrames {
  const from = `${direction * 100}%`;
  const to = `${direction * -100}%`;
  switch (kind) {
    case "fade":
      return { incoming: null, outgoing: [{ opacity: 1 }, { opacity: 0 }], easing: EASE_IN_OUT };
    case "dissolve":
      return {
        incoming: null,
        outgoing: [
          { opacity: 1, filter: "blur(0px)" },
          { opacity: 0, filter: "blur(10px)" },
        ],
        easing: "linear",
      };
    case "slide":
      return {
        incoming: [{ transform: `translateX(${from})` }, { transform: "translateX(0)" }],
        outgoing: null,
        easing: EASE,
      };
    case "push":
      return {
        incoming: [{ transform: `translateX(${from})` }, { transform: "translateX(0)" }],
        outgoing: [{ transform: "translateX(0)" }, { transform: `translateX(${to})` }],
        easing: EASE,
      };
    case "zoom":
      return {
        incoming: [
          { transform: "scale(.86)", opacity: 0 },
          { transform: "scale(1)", opacity: 1 },
        ],
        outgoing: [
          { transform: "scale(1)", opacity: 1 },
          { transform: "scale(1.08)", opacity: 0 },
        ],
        easing: EASE,
      };
    default:
      return { incoming: null, outgoing: null, easing: "linear" };
  }
}

/** Runs a transition; resolves when it finished (immediately for "none"). */
export async function runTransition(args: TransitionArgs): Promise<void> {
  if (args.kind === "none" || args.durationMs <= 0) return;
  const frames = transitionFrames(args.kind, args.direction);
  const timing: KeyframeAnimationOptions = {
    duration: args.durationMs,
    easing: frames.easing,
    fill: "forwards",
  };
  const animations: Animation[] = [];
  // The snapshot stays on top for fades / dissolves / zooms; for slides the incoming stage moves over it.
  if (args.outgoing) args.outgoing.style.zIndex = args.kind === "slide" ? "0" : "2";
  if (args.incoming && args.kind === "slide") args.incoming.style.zIndex = "1";
  if (args.incoming && frames.incoming && typeof args.incoming.animate === "function") {
    animations.push(args.incoming.animate(frames.incoming, timing));
  }
  if (args.outgoing && frames.outgoing && typeof args.outgoing.animate === "function") {
    animations.push(args.outgoing.animate(frames.outgoing, timing));
  }
  await Promise.all(animations.map((a) => a.finished.catch(() => undefined)));
  for (const a of animations) a.cancel();
  if (args.outgoing) args.outgoing.style.zIndex = "";
  if (args.incoming) args.incoming.style.zIndex = "";
}
