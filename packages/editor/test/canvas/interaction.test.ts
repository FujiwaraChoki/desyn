import { createPath, type Id, type Node } from "@desyn/schema";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasController } from "../../src/canvas/controller.ts";
import type { EditorController } from "../../src/controller.ts";
import { ALL_TOOLS } from "../../src/tools/index.ts";
import { startPathEditing } from "../../src/tools/pen.ts";
import { createTestEditor, fixture, withNodes } from "../editor-helpers.ts";
import { until } from "../fake-server.ts";
import { createFrame, createRect } from "./fixtures.ts";

/**
 * The canvas state machine end to end in jsdom: real controller, tools and gestures over a test editor (fake
 * Convex, no engine: hit tests use node boxes, previews commit the last previewed transaction). The view is
 * the identity (zoom 1 at the origin), so screen and page coordinates coincide.
 */

let current: { c: CanvasController; editor: EditorController; root: HTMLElement } | null = null;

afterEach(async () => {
  current?.c.dispose();
  current?.root.remove();
  await current?.editor.dispose();
  current = null;
});

async function mount(design = fixture().design) {
  const t = await createTestEditor(design);
  const root = document.createElement("div");
  const overlay = document.createElement("canvas");
  const dom = document.createElement("div");
  root.append(overlay, dom);
  document.body.append(root);
  const c = new CanvasController(t.editor, root, overlay, dom, ALL_TOOLS);
  current = { c, editor: t.editor, root };
  return { ...t, c, root };
}

const settle = () => new Promise((r) => setTimeout(r, 15));

interface Mods {
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  ctrl?: boolean;
}

function fire(root: HTMLElement, type: string, x: number, y: number, mods: Mods = {}, buttons = 1) {
  root.dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : buttons,
      pointerId: 1,
      pointerType: "mouse",
      bubbles: true,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      metaKey: !!mods.meta,
      ctrlKey: !!mods.ctrl,
    }),
  );
}

async function click(root: HTMLElement, x: number, y: number, mods: Mods = {}) {
  fire(root, "pointerdown", x, y, mods);
  await settle();
  fire(root, "pointerup", x, y, mods);
  await settle();
}

async function drag(
  root: HTMLElement,
  from: [number, number],
  to: [number, number],
  mods: Mods = {},
) {
  fire(root, "pointerdown", from[0], from[1], mods);
  await settle();
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    fire(root, "pointermove", x, y, mods);
    await settle();
  }
  fire(root, "pointerup", to[0], to[1], mods);
  await settle();
  await settle();
}

const node = (editor: EditorController, id: Id) => editor.design?.nodes[id] as Node;

describe("selection", () => {
  it("clicks select layers and empty canvas clears", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    await click(root, 50, 30);
    expect(editor.getState().selection).toEqual([f.a]);
    await click(root, 240, 140, { shift: true });
    expect(editor.getState().selection).toEqual([f.a, f.b]);
    // A second shift-click on B away from the first (a click at the same spot would be a double click).
    await click(root, 260, 160, { shift: true });
    expect(editor.getState().selection).toEqual([f.a]);
    await click(root, 800, 50);
    expect(editor.getState().selection).toEqual([]);
  });

  it("marquee selects touching layers; Escape restores the old selection", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    await drag(root, [0, 0], [300, 200]);
    expect(editor.getState().selection).toEqual([f.a, f.b]);
    await click(root, 800, 800);
    fire(root, "pointerdown", 0, 0);
    await settle();
    fire(root, "pointermove", 300, 200);
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    fire(root, "pointerup", 300, 200);
    await settle();
    expect(editor.getState().selection).toEqual([]);
  });

  it("double click enters a group and selects the child", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    // G is rotated 30° about its center (550, 550): its children cover the center region.
    await click(root, 552, 552);
    expect(editor.getState().selection).toEqual([f.g]);
    fire(root, "pointerdown", 552, 552);
    await settle();
    fire(root, "pointerup", 552, 552);
    fire(root, "pointerdown", 552, 552);
    await settle();
    fire(root, "pointerup", 552, 552);
    await settle();
    expect(editor.getState().scopeId).toBe(f.g);
    expect([f.g1, f.g2]).toContain(editor.getState().selection[0]);
  });
});

describe("move", () => {
  it("drags a layer as one undo step", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    await drag(root, [50, 30], [80, 50]);
    expect(node(editor, f.a)).toMatchObject({ x: 40, y: 30 });
    expect(editor.getState().history.undoLabel).toBe("Move");
    await editor.undo();
    expect(node(editor, f.a)).toMatchObject({ x: 10, y: 10 });
  });

  it("shift locks to the dominant axis", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    await drag(root, [50, 30], [110, 40], { shift: true });
    expect(node(editor, f.a)).toMatchObject({ x: 70, y: 10 });
  });

  it("alt drags a copy and selects it", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    await drag(root, [240, 140], [340, 140], { alt: true });
    const sel = editor.getState().selection;
    expect(sel).toHaveLength(1);
    expect(sel[0]).not.toBe(f.b);
    expect(node(editor, sel[0] as Id)).toMatchObject({ x: 300, y: 100, name: "B" });
    expect(node(editor, f.b)).toMatchObject({ x: 200, y: 100 });
    expect(editor.getState().history.undoLabel).toBe("Duplicate");
  });

  it("drops layers into a frame under the pointer", async () => {
    const f = fixture();
    const frame = createFrame({
      parent: f.page,
      name: "Card",
      x: 600,
      y: 0,
      width: 300,
      height: 300,
    });
    const design = withNodes(f.design, f.page, [frame]);
    const { editor, root } = await mount(design);
    await drag(root, [50, 30], [700, 100]);
    const a = node(editor, f.a);
    expect(a.parent).toBe(frame.id);
    // Same place on the page: 10 + 650 - 600 in the frame's coordinates.
    expect(a).toMatchObject({ x: 60, y: 80 });
  });

  it("reorders children of an auto-layout frame by dragging", async () => {
    const f = fixture();
    const row = createFrame({
      parent: f.page,
      name: "Row",
      x: 0,
      y: 700,
      width: 400,
      height: 100,
      layout: {
        mode: "row",
        gap: 10,
        padding: [0, 0, 0, 0],
        mainAlign: "start",
        crossAlign: "start",
      },
    });
    const kids = [0, 1, 2].map((i) =>
      createRect({ parent: row.id, name: `R${i}`, x: i * 110, y: 0, width: 100, height: 100 }),
    );
    let design = withNodes(f.design, f.page, [row]);
    design = withNodes(design, row.id, kids);
    const { editor, root } = await mount(design);
    // Enter the row so the click selects R0.
    editor.store.setState({ scopeId: row.id });
    await drag(root, [50, 750], [300, 750]);
    const order = (node(editor, row.id) as Node & { children: Id[] }).children;
    expect(order).toEqual([kids[1]?.id, kids[2]?.id, kids[0]?.id]);
    expect(editor.getState().history.undoLabel).toBe("Reorder");
  });
});

describe("transform handles", () => {
  it("resizes from a corner handle", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.select([f.b]);
    await settle();
    // B: 200,100 80×80; drag the bottom-right corner (280, 180) to (320, 200).
    await drag(root, [280, 180], [320, 200]);
    expect(node(editor, f.b)).toMatchObject({ x: 200, y: 100, width: 120, height: 100 });
    expect(editor.getState().history.undoLabel).toBe("Resize");
  });

  it("keeps the aspect ratio with shift", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.select([f.b]);
    await settle();
    await drag(root, [280, 180], [360, 190], { shift: true });
    const b = node(editor, f.b);
    expect(b.width).toBeCloseTo(b.height);
    expect(b.width).toBeCloseTo(160);
  });

  it("rotates from outside a corner, snapping to 15° with shift", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.select([f.b]);
    await settle();
    // Center (240, 140). Start just outside the top-right corner and swing towards the bottom-right.
    await drag(root, [290, 92], [292, 185], { shift: true });
    const r = node(editor, f.b).rotation;
    expect(Math.abs(r % 15)).toBeLessThan(1e-6);
    expect(r).toBeGreaterThan(0);
  });

  it("rotates with the knob under the selection", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.select([f.b]);
    await settle();
    // B: 200,100 80×80, center (240, 140); the knob sits 26 px under the bottom edge at (240, 206).
    await drag(root, [240, 206], [300, 140]);
    const b = node(editor, f.b);
    expect(Math.abs(b.rotation)).toBeCloseTo(90);
    expect(b.width).toBeCloseTo(80);
  });

  it("rotates a line with the knob", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("line");
    await settle();
    await drag(root, [600, 600], [700, 600]);
    const id = editor.getState().selection[0] as Id;
    expect(node(editor, id).rotation).toBeCloseTo(0);
    // Center (650, 600); the knob is 26 px below it. Swing it to the right of the center: a quarter turn.
    await drag(root, [650, 626], [720, 600]);
    const line = node(editor, id);
    expect(Math.abs(line.rotation)).toBeCloseTo(90);
    expect(line.width).toBeCloseTo(100);
  });

  it("drags the corner radius handle of a rectangle", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.select([f.a]);
    await settle();
    // A: 10,10 100×50; the radius handle sits 12 px inside the top-left corner.
    await drag(root, [22, 22], [30, 30]);
    expect((node(editor, f.a) as Node & { cornerRadius: number }).cornerRadius).toBe(20);
  });
});

describe("drawing tools", () => {
  it("draws a rectangle and returns to the select tool", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("rect");
    await settle();
    await drag(root, [600, 100], [700, 160]);
    const id = editor.getState().selection[0] as Id;
    expect(node(editor, id)).toMatchObject({
      type: "rect",
      x: 600,
      y: 100,
      width: 100,
      height: 60,
    });
    expect(editor.getState().tool).toBe("select");
  });

  it("draws a square from the center with shift + alt and keeps a locked tool", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("ellipse", { locked: true });
    await settle();
    await drag(root, [700, 700], [740, 720], { shift: true, alt: true });
    const id = editor.getState().selection[0] as Id;
    expect(node(editor, id)).toMatchObject({
      type: "ellipse",
      x: 660,
      y: 660,
      width: 80,
      height: 80,
    });
    expect(editor.getState().tool).toBe("ellipse");
  });

  it("clicks a default-size shape", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("star");
    await settle();
    await click(root, 700, 700);
    const id = editor.getState().selection[0] as Id;
    expect(node(editor, id)).toMatchObject({
      type: "star",
      x: 650,
      y: 650,
      width: 100,
      height: 100,
    });
  });

  it("draws lines and arrows", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("arrow");
    await settle();
    await drag(root, [600, 600], [600, 700]);
    const id = editor.getState().selection[0] as Id;
    const line = node(editor, id) as Node & { endCap: string };
    expect(line).toMatchObject({ type: "line", width: 100 });
    expect(line.rotation).toBeCloseTo(90);
    expect(line.endCap).toBe("arrow");
  });

  it("builds a path with the pen and finishes with Enter", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("pen");
    await settle();
    await click(root, 600, 600);
    await drag(root, [700, 600], [740, 640]);
    await click(root, 700, 700);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => editor.getState().selection.length === 1);
    const id = editor.getState().selection[0] as Id;
    const path = node(editor, id) as Node & { paths: { d: string }[] };
    expect(path.type).toBe("path");
    // The curve bulges above its first point (the dragged point's incoming handle), so the box starts above it.
    expect(path.paths[0]?.d).toMatch(/^M0 17\.778C/);
    expect(path).toMatchObject({ x: 600 });
    expect(path.y).toBeLessThan(600);
    expect(editor.getState().tool).toBe("select");
  });

  it("closes a pen path by clicking its first point", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("pen");
    await settle();
    await click(root, 600, 600);
    await click(root, 700, 600);
    await click(root, 650, 680);
    await click(root, 601, 601);
    await until(() => editor.getState().selection.length === 1);
    const path = node(editor, editor.getState().selection[0] as Id) as Node & {
      paths: { d: string }[];
    };
    expect(path.paths[0]?.d.endsWith("Z")).toBe(true);
  });

  it("draws a smoothed freehand stroke with the pencil", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("pencil");
    await settle();
    fire(root, "pointerdown", 600, 600);
    await settle();
    for (let i = 1; i <= 40; i++) {
      fire(root, "pointermove", 600 + i * 5, 600 + Math.sin(i / 4) * 30);
    }
    fire(root, "pointerup", 800, 600);
    await until(() => editor.getState().selection.length === 1);
    const path = node(editor, editor.getState().selection[0] as Id) as Node & {
      paths: { d: string }[];
      strokes: { width: number }[];
    };
    expect(path.type).toBe("path");
    expect(path.paths[0]?.d).toContain("C");
    expect(path.strokes[0]?.width).toBe(3);
  });

  it("opens the inline comment composer without a collaboration extension", async () => {
    const f = fixture();
    const { editor, c, root } = await mount(f.design);
    editor.setTool("comment");
    await settle();
    await click(root, 50, 30);
    expect(c.getUi().composer).toMatchObject({ nodeId: f.a, page: { x: 50, y: 30 } });
  });

  it("needs the engine to start typing", async () => {
    const f = fixture();
    const { editor, root, notices } = await mount(f.design);
    editor.setTool("text");
    await settle();
    await click(root, 600, 600);
    expect(notices.some((n) => n.title.includes("still starting"))).toBe(true);
    expect(Object.values(editor.design?.nodes ?? {}).some((n) => n.type === "text")).toBe(false);
  });
});

describe("review regressions", () => {
  it("alt+click selects through a stack of layers, one deeper per click, wrapping around", async () => {
    const f = fixture();
    const stack = ["X", "Y", "Z"].map((name) =>
      createRect({ parent: f.page, name, x: 600, y: 600, width: 100, height: 100 }),
    );
    const { editor, root } = await mount(withNodes(f.design, f.page, stack));
    const [x, y, z] = stack.map((n) => n.id);
    // Points 10 px apart so the clicks never count as double clicks.
    const picks: Id[] = [];
    for (const [i, px] of [610, 625, 640, 655].entries()) {
      await click(root, px, 620 + i * 10, { alt: true });
      picks.push(editor.getState().selection[0] as Id);
    }
    expect(picks).toEqual([z, y, x, z]);
  });

  it("keeps the final size of a shape drawn with a quick flick", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    editor.setTool("rect");
    await settle();
    fire(root, "pointerdown", 600, 100);
    await settle();
    // Move and release in the same task: the release arrives before the move's snap query resolves.
    fire(root, "pointermove", 700, 160);
    fire(root, "pointerup", 700, 160);
    await until(() => editor.getState().selection.length === 1);
    const id = editor.getState().selection[0] as Id;
    expect(node(editor, id)).toMatchObject({ type: "rect", width: 100, height: 60 });
  });

  it("drops a quickly dragged layer where the pointer was released", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    fire(root, "pointerdown", 50, 30);
    await settle();
    fire(root, "pointermove", 70, 40);
    fire(root, "pointermove", 90, 60);
    fire(root, "pointerup", 90, 60);
    await until(() => editor.getState().history.undoLabel === "Move");
    expect(node(editor, f.a)).toMatchObject({ x: 50, y: 40 });
  });

  it("a fast click never turns pointer moves after the release into a drag", async () => {
    const f = fixture();
    const { editor, root } = await mount(f.design);
    // Press and release before the hit test resolves, then move away with alt held.
    fire(root, "pointerdown", 50, 30);
    fire(root, "pointerup", 50, 30);
    fire(root, "pointermove", 400, 400, { alt: true }, 0);
    await settle();
    await settle();
    expect(editor.getState().selection).toEqual([f.a]);
    expect(node(editor, f.a)).toMatchObject({ x: 10, y: 10 });
    expect(editor.getState().history.undoLabel).toBeNull();
  });

  it("path editing follows changes made outside the mode (undo, inspector)", async () => {
    const f = fixture();
    const path = createPath({
      parent: f.page,
      name: "P",
      x: 600,
      y: 600,
      width: 100,
      height: 100,
      paths: [{ d: "M0 0L100 100", fillRule: "nonzero" }],
    });
    const { editor, c } = await mount(withNodes(f.design, f.page, [path]));
    await startPathEditing(c, path.id);
    expect(c.mode?.kind).toBe("path");
    await editor.apply(
      [{ op: "update", id: path.id, set: { paths: [{ d: "M0 0L50 100", fillRule: "nonzero" }] } }],
      { label: "Inspector" },
    );
    await settle();
    const entries = (c.mode as unknown as { entries: { anchors: { x: number }[] }[][] }).entries;
    expect(entries[0]?.[0]?.anchors.map((a) => a.x)).toEqual([0, 50]);
  });

  it("leaves Enter to a focused panel button outside the canvas", async () => {
    const f = fixture();
    const path = createPath({
      parent: f.page,
      name: "P",
      x: 600,
      y: 600,
      width: 100,
      height: 100,
      paths: [{ d: "M0 0L100 100", fillRule: "nonzero" }],
    });
    const { editor, c } = await mount(withNodes(f.design, f.page, [path]));
    editor.select([path.id]);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const press = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    button.dispatchEvent(press);
    await settle();
    expect(c.mode).toBeNull();
    expect(press.defaultPrevented).toBe(false);
    button.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(c.mode?.kind).toBe("path");
  });

  it("the comment tool explains why viewers cannot comment", async () => {
    const f = fixture();
    const t = await createTestEditor(f.design, { permission: "view" });
    const root = document.createElement("div");
    const overlay = document.createElement("canvas");
    const dom = document.createElement("div");
    root.append(overlay, dom);
    document.body.append(root);
    const c = new CanvasController(t.editor, root, overlay, dom, ALL_TOOLS);
    current = { c, editor: t.editor, root };
    t.editor.store.setState({ tool: "comment" });
    await settle();
    await click(root, 50, 30);
    expect(c.getUi().composer).toBeNull();
    expect(t.notices.some((n) => n.title.includes("not comment"))).toBe(true);
  });
});
