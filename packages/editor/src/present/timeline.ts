import { pages } from "@desyn/doc-ops";
import type { Animation, Design, Id, PageNode } from "@desyn/schema";

/**
 * Presentation timeline (pure): per-slide animation timing from the document's `Animation` data and the
 * navigation state machine (enter -> hold -> exit) the presenter drives. Semantics follow
 * crates/desyn-raster `anim`: `in` animations play from their start and rest in the designed state, `out`
 * animations leave the designed state at their start, `loop` animations repeat from their start.
 */

export type TransitionKind = NonNullable<PageNode["transition"]>["kind"];

export interface SlideTiming {
  pageId: Id;
  name: string;
  notes: string;
  /** End of the last entrance animation (ms); 0 without entrance animations. */
  inEnd: number;
  /** Start of the first exit animation, or null. */
  outStart: number | null;
  /** End of the last exit animation, or null. */
  outEnd: number | null;
  /** Some node loops (the clock keeps running while the slide is shown). */
  loops: boolean;
  /** Auto-advance after this long (page `durationMs`), or null. */
  autoAdvanceMs: number | null;
  /** Transition into this slide. */
  transition: { kind: TransitionKind; durationMs: number };
  /** Any animation at all (render with a clock). */
  animated: boolean;
}

function animationsOf(design: Design, pageId: Id): Animation[] {
  const out: Animation[] = [];
  const stack: Id[] = [pageId];
  while (stack.length > 0) {
    const id = stack.pop() as Id;
    const n = design.nodes[id] as (PageNode & { anim?: Animation[]; children?: Id[] }) | undefined;
    if (!n) continue;
    if (n.visible === false && id !== pageId) continue;
    for (const a of n.anim ?? []) {
      if (a.preset === "none") continue;
      if (!Number.isFinite(a.startMs) || !Number.isFinite(a.durationMs) || a.durationMs < 0)
        continue;
      out.push(a);
    }
    if (n.children) stack.push(...n.children);
  }
  return out;
}

const TRANSITION_MAX_MS = 3000;

export function slideTiming(design: Design, page: PageNode): SlideTiming {
  const anims = animationsOf(design, page.id);
  let inEnd = 0;
  let outStart: number | null = null;
  let outEnd: number | null = null;
  let loops = false;
  for (const a of anims) {
    const end = a.startMs + a.durationMs;
    if (a.phase === "in") inEnd = Math.max(inEnd, end);
    else if (a.phase === "out") {
      outStart = outStart === null ? a.startMs : Math.min(outStart, a.startMs);
      outEnd = outEnd === null ? end : Math.max(outEnd, end);
    } else loops = true;
  }
  const t = page.transition;
  const transition =
    t && t.kind !== "none" && Number.isFinite(t.durationMs) && t.durationMs > 0
      ? { kind: t.kind, durationMs: Math.min(TRANSITION_MAX_MS, t.durationMs) }
      : { kind: "none" as const, durationMs: 0 };
  return {
    pageId: page.id,
    name: page.name,
    notes: (page as PageNode & { notes?: string }).notes ?? "",
    inEnd,
    outStart,
    outEnd,
    loops,
    autoAdvanceMs:
      typeof page.durationMs === "number" && Number.isFinite(page.durationMs) && page.durationMs > 0
        ? page.durationMs
        : null,
    transition,
    animated: anims.length > 0,
  };
}

/** Slides of a presentation: visible pages in order. */
export function presentationSlides(design: Design): SlideTiming[] {
  return pages(design)
    .filter((p) => p.visible !== false)
    .map((p) => slideTiming(design, p));
}

/**
 * Animation time to render `elapsed` ms after a slide appeared, while it is shown (before exiting): entrance
 * animations play, then the slide rests. Loops keep the clock running, but never into the exit animations.
 */
export function holdTime(slide: SlideTiming, elapsed: number): number {
  const t = Math.max(0, elapsed);
  const limit =
    slide.outStart === null ? Number.POSITIVE_INFINITY : Math.max(0, slide.outStart - 1);
  if (slide.loops) return Math.min(t, limit);
  return Math.min(t, slide.inEnd, limit);
}

/** Time to render `elapsed` ms into the exit phase, or null when the slide has no exit animations. */
export function exitTime(slide: SlideTiming, elapsed: number, from: number): number | null {
  if (slide.outStart === null || slide.outEnd === null) return null;
  const start = Math.max(from, slide.outStart);
  return Math.min(slide.outEnd, start + Math.max(0, elapsed));
}

/** Duration of the exit phase when leaving at animation time `from`. */
export function exitDuration(slide: SlideTiming, from: number): number {
  if (slide.outStart === null || slide.outEnd === null) return 0;
  return Math.max(0, slide.outEnd - Math.max(from, slide.outStart));
}

/** True when the entrance (and loops' first cycle) is still playing at `elapsed`. */
export function isEntering(slide: SlideTiming, elapsed: number): boolean {
  return elapsed < slide.inEnd;
}

// ---------------------------------------------------------------------------------------------------------
// Navigation

export interface NavState {
  index: number;
  /** Slide shown before the current one while a transition runs (null otherwise). */
  from: number | null;
  direction: 1 | -1;
  /** Bumps on every slide change (keys the transition). */
  serial: number;
}

export type NavAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "first" }
  | { type: "last" }
  | { type: "settled" };

export function initialNav(index: number, count: number): NavState {
  return { index: clampIndex(index, count), from: null, direction: 1, serial: 0 };
}

function clampIndex(i: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(i)));
}

/** Slide navigation; out-of-range moves keep the state (the presenter shows the end screen itself). */
export function navigate(state: NavState, action: NavAction, count: number): NavState {
  const go = (index: number): NavState => {
    const target = clampIndex(index, count);
    if (target === state.index) return state.from === null ? state : { ...state, from: null };
    return {
      index: target,
      from: state.index,
      direction: target > state.index ? 1 : -1,
      serial: state.serial + 1,
    };
  };
  switch (action.type) {
    case "next":
      return state.index + 1 < count ? go(state.index + 1) : state;
    case "prev":
      return state.index > 0 ? go(state.index - 1) : state;
    case "goto":
      return go(action.index);
    case "first":
      return go(0);
    case "last":
      return go(count - 1);
    case "settled":
      return state.from === null ? state : { ...state, from: null };
  }
}

/** "1:05", "12:40", "1:02:03" for the presenter timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Keyboard / clicker keys of the presenter. */
export type PresenterKeyAction =
  | NavAction
  | { type: "exit" }
  | { type: "black" }
  | { type: "white" }
  | { type: "fullscreen" }
  | { type: "presenterView" }
  | { type: "overview" }
  | { type: "digit"; digit: number }
  | { type: "commitDigits" };

/**
 * Maps a key to a presenter action. Presentation clickers send PageDown / PageUp (some send arrows, "b" or
 * "." for black, F5 / Escape to start / stop).
 */
export function presenterKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
): PresenterKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "n":
    case "N":
      return e.key === " " && e.shiftKey ? { type: "prev" } : { type: "next" };
    case "Enter":
      return { type: "commitDigits" };
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
    case "p":
    case "P":
      return { type: "prev" };
    case "Home":
      return { type: "first" };
    case "End":
      return { type: "last" };
    case "Escape":
      return { type: "exit" };
    case "b":
    case "B":
    case ".":
      return { type: "black" };
    case "w":
    case "W":
    case ",":
      return { type: "white" };
    case "f":
    case "F":
    case "F5":
      return { type: "fullscreen" };
    case "s":
    case "S":
      return { type: "presenterView" };
    case "g":
    case "G":
      return { type: "overview" };
    default:
      if (/^[0-9]$/.test(e.key)) return { type: "digit", digit: Number(e.key) };
      return null;
  }
}
