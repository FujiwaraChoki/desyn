import type { Animation, Design, Id, Node, PageNode } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  exitDuration,
  exitTime,
  formatClock,
  holdTime,
  initialNav,
  navigate,
  presentationSlides,
  presenterKey,
  slideTiming,
} from "../../src/present/timeline.ts";
import { transitionFrames } from "../../src/present/transitions.ts";
import { fixture } from "../collab/fixtures.ts";

const anim = (over: Partial<Animation>): Animation => ({
  id: "anim00000001",
  preset: "fade",
  phase: "in",
  startMs: 0,
  durationMs: 500,
  easing: "ease-out",
  ...over,
});

function animated(): { design: Design; page: PageNode } {
  const f = fixture();
  const nodes = { ...f.design.nodes };
  nodes[f.a] = { ...(nodes[f.a] as Node), anim: [anim({ startMs: 200, durationMs: 600 })] } as Node;
  nodes[f.b] = {
    ...(nodes[f.b] as Node),
    anim: [
      anim({ phase: "out", startMs: 3000, durationMs: 400 }),
      anim({ phase: "loop", preset: "pulse" }),
    ],
  } as Node;
  // Hidden layers do not animate the slide.
  nodes[f.c] = { ...(nodes[f.c] as Node), visible: false, anim: [anim({ startMs: 9000 })] } as Node;
  nodes[f.page] = {
    ...(nodes[f.page] as Node),
    transition: { kind: "push", durationMs: 9000 },
    durationMs: 5000,
    notes: "Talk about the logo",
  } as Node;
  const design = { ...f.design, nodes };
  return { design, page: design.nodes[f.page] as PageNode };
}

describe("slide timing", () => {
  test("entrance end, exit window, loops, auto-advance, capped transition, notes", () => {
    const { design, page } = animated();
    const s = slideTiming(design, page);
    expect(s).toMatchObject({
      inEnd: 800,
      outStart: 3000,
      outEnd: 3400,
      loops: true,
      autoAdvanceMs: 5000,
      transition: { kind: "push", durationMs: 3000 },
      notes: "Talk about the logo",
      animated: true,
    });
  });

  test("hold time plays entrances, keeps loops running but stops before exits", () => {
    const { design, page } = animated();
    const s = slideTiming(design, page);
    expect(holdTime(s, 100)).toBe(100);
    expect(holdTime(s, 2000)).toBe(2000); // loops keep the clock running
    expect(holdTime(s, 10_000)).toBe(2999); // never into the exit
    const still = { ...s, loops: false };
    expect(holdTime(still, 2000)).toBe(800); // rests after the entrance
    expect(holdTime(still, -5)).toBe(0);
    expect(exitDuration(s, 800)).toBe(400);
    expect(exitTime(s, 0, 800)).toBe(3000);
    expect(exitTime(s, 250, 800)).toBe(3250);
    expect(exitTime(s, 9999, 800)).toBe(3400);
    expect(exitTime({ ...s, outStart: null, outEnd: null }, 10, 0)).toBeNull();
  });

  test("hidden pages are skipped; static pages have no clock", () => {
    const f = fixture();
    const root = f.design.nodes.root as Node & { children: Id[] };
    const hidden = {
      ...(f.design.nodes[f.page] as Node),
      id: "hiddenpage01",
      visible: false,
      children: [],
    } as Node;
    const design = {
      ...f.design,
      nodes: {
        ...f.design.nodes,
        root: { ...root, children: [...root.children, "hiddenpage01"] } as Node,
        hiddenpage01: hidden,
      },
    };
    const slides = presentationSlides(design);
    expect(slides.map((s) => s.pageId)).toEqual([f.page]);
    expect(slides[0]).toMatchObject({
      animated: false,
      inEnd: 0,
      transition: { kind: "none", durationMs: 0 },
      autoAdvanceMs: null,
    });
  });
});

describe("navigation", () => {
  test("next / prev / goto / first / last with transition bookkeeping", () => {
    let s = initialNav(0, 3);
    s = navigate(s, { type: "prev" }, 3);
    expect(s.index).toBe(0);
    s = navigate(s, { type: "next" }, 3);
    expect(s).toMatchObject({ index: 1, from: 0, direction: 1, serial: 1 });
    s = navigate(s, { type: "settled" }, 3);
    expect(s.from).toBeNull();
    s = navigate(s, { type: "last" }, 3);
    expect(s).toMatchObject({ index: 2, from: 1, direction: 1 });
    s = navigate(s, { type: "next" }, 3);
    expect(s.index).toBe(2); // the presenter shows its end screen itself
    s = navigate(s, { type: "goto", index: 0 }, 3);
    expect(s).toMatchObject({ index: 0, direction: -1, serial: 3 });
    expect(navigate(s, { type: "goto", index: 99 }, 3).index).toBe(2);
    expect(initialNav(7, 3).index).toBe(2);
    expect(initialNav(-1, 0).index).toBe(0);
  });

  test("clicker and keyboard keys", () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
      presenterKey({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods })
        ?.type ?? null;
    expect(k("PageDown")).toBe("next");
    expect(k("ArrowRight")).toBe("next");
    expect(k(" ")).toBe("next");
    expect(k(" ", { shiftKey: true })).toBe("prev");
    expect(k("PageUp")).toBe("prev");
    expect(k("Backspace")).toBe("prev");
    expect(k("b")).toBe("black");
    expect(k(".")).toBe("black");
    expect(k("w")).toBe("white");
    expect(k("F5")).toBe("fullscreen");
    expect(k("Escape")).toBe("exit");
    expect(k("s")).toBe("presenterView");
    expect(k("g")).toBe("overview");
    expect(k("Home")).toBe("first");
    expect(k("7")).toBe("digit");
    expect(k("Enter")).toBe("commitDigits");
    expect(k("r", { ctrlKey: true })).toBeNull();
    expect(k("x")).toBeNull();
  });

  test("timer formatting", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(-5)).toBe("0:00");
  });

  test("transition keyframes mirror for going back", () => {
    expect(transitionFrames("slide", 1).incoming?.[0]).toEqual({ transform: "translateX(100%)" });
    expect(transitionFrames("slide", -1).incoming?.[0]).toEqual({ transform: "translateX(-100%)" });
    expect(transitionFrames("push", 1).outgoing?.[1]).toEqual({ transform: "translateX(-100%)" });
    expect(transitionFrames("fade", 1)).toMatchObject({
      incoming: null,
      outgoing: [{ opacity: 1 }, { opacity: 0 }],
    });
    expect(transitionFrames("none", 1)).toMatchObject({ incoming: null, outgoing: null });
  });
});
