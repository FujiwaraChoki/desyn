import { applyTransaction } from "@desyn/doc-ops";
import {
  canonicalize,
  createEllipse,
  type Design,
  defaultTextStyle,
  type FrameNode,
  type Id,
  type Node,
  type TextNode,
} from "@desyn/schema";
import { describe, expect, it } from "vitest";
import {
  addTextInto,
  hostsText,
  isTextBox,
  textChildOf,
  textIntoOps,
} from "../../src/tools/text.ts";
import { createDesign, createFrame, createImage, createRect, makeTx } from "./fixtures.ts";

const PAGE = { width: 1080, height: 1080 };

function withNodes(nodes: Node[], tweak?: (d: Design) => void) {
  const { design, page } = createDesign();
  tweak?.(design);
  const applied = applyTransaction(
    design,
    makeTx(nodes.map((n) => ({ op: "create" as const, nodes: [n], parent: page }))),
  );
  return { design: applied.design, page };
}

let seq = 0;
const ids = () => `textinto${String(++seq).padStart(4, "0")}`;

/** Applies the double click's step; returns the design after it, the step's inverse, and the new ids. */
function addText(design: Design, id: Id) {
  const made = textIntoOps(design, id, PAGE, ids);
  if (!made) throw new Error(`no text for ${id}`);
  const result = applyTransaction(design, makeTx(made.ops));
  expect(result.dropped).toEqual([]);
  return { ...made, design: result.design, inverse: result.inverse };
}

const kids = (d: Design, id: Id) => (d.nodes[id] as FrameNode).children;

describe("double click puts text inside shapes (Canva style)", () => {
  it("turns a rectangle into a text container with the same paint and box", () => {
    const rect = createRect({
      x: 100,
      y: 200,
      width: 400,
      height: 200,
      rotation: 15,
      cornerRadius: 24,
      role: "button",
      name: "Pill",
      fills: [{ type: "solid", color: "#c4451c" }],
    });
    const above = createEllipse({ x: 600, y: 600, width: 50, height: 50 });
    const { design, page } = withNodes([rect, above]);
    const { design: after, containerId, textId } = addText(design, rect.id);
    expect(after.nodes[rect.id]).toBeUndefined();
    const frame = after.nodes[containerId] as FrameNode;
    expect(frame).toMatchObject({
      type: "frame",
      name: "Pill",
      role: "button",
      x: 100,
      y: 200,
      width: 400,
      height: 200,
      rotation: 15,
      cornerRadius: 24,
      fills: [{ type: "solid", color: "#c4451c" }],
    });
    expect(isTextBox(frame)).toBe(true);
    // Same stacking position as the rectangle had, below the ellipse.
    expect(kids(after, page)).toEqual([containerId, above.id]);
    expect(kids(after, containerId)).toEqual([textId]);
    const text = after.nodes[textId] as TextNode;
    expect(text).toMatchObject({
      type: "text",
      runs: [],
      rotation: 0,
      verticalAlign: "middle",
      autoResize: "none",
      constraints: { h: "stretch", v: "stretch" },
    });
    expect(text.paragraph.align).toBe("center");
    expect(text.x).toBeGreaterThan(0);
    expect(text.x + text.width).toBeLessThan(400);
    // White ink on the dark orange fill, sized for the shape.
    expect((text.style.fills[0] as { color: string }).color).toBe("#ffffff");
    expect(text.style.fontSize).toBeLessThanOrEqual(70);
    expect(textChildOf(after, containerId)).toBe(textId);
  });

  it("wraps other shapes in a frame: the shape stretches behind the text", () => {
    const circle = createEllipse({
      x: 50,
      y: 60,
      width: 300,
      height: 300,
      rotation: 10,
      role: "badge",
    });
    const { design, page } = withNodes([circle]);
    const { design: after, containerId, textId } = addText(design, circle.id);
    const frame = after.nodes[containerId] as FrameNode;
    expect(frame).toMatchObject({
      x: 50,
      y: 60,
      width: 300,
      height: 300,
      rotation: 10,
      role: "badge",
      fills: [],
    });
    expect(kids(after, page)).toEqual([containerId]);
    expect(kids(after, containerId)).toEqual([circle.id, textId]);
    expect(after.nodes[circle.id]).toMatchObject({
      parent: containerId,
      x: 0,
      y: 0,
      rotation: 0,
      constraints: { h: "stretch", v: "stretch" },
    });
    expect(after.nodes[circle.id]?.role).toBeUndefined();
  });

  it("undoes to exactly the original shape", () => {
    for (const shape of [
      createRect({
        x: 10,
        y: 10,
        width: 200,
        height: 80,
        fills: [{ type: "solid", color: "#f6efe4" }],
      }),
      createEllipse({ x: 300, y: 10, width: 120, height: 120 }),
    ]) {
      const { design } = withNodes([shape]);
      const { design: after, inverse } = addText(design, shape.id);
      const back = applyTransaction(after, inverse).design;
      expect(canonicalize(back.nodes)).toBe(canonicalize(design.nodes));
    }
  });

  it("picks an ink that reads on named color styles", () => {
    const shape = createRect({
      x: 0,
      y: 0,
      width: 300,
      height: 120,
      fills: [{ type: "solid", color: { $style: "darkstyle001" } }],
    });
    const { design } = withNodes([shape], (d) => {
      d.styles.colors.darkstyle001 = { name: "Night", value: "#101820" };
    });
    const { design: after, textId } = addText(design, shape.id);
    expect(((after.nodes[textId] as TextNode).style.fills[0] as { color: string }).color).toBe(
      "#ffffff",
    );
  });

  it("uses the design's body font when it names one", () => {
    const shape = createRect({ x: 0, y: 0, width: 300, height: 120 });
    const { design } = withNodes([shape], (d) => {
      d.styles.text.bodystyle01 = {
        name: "Body",
        style: defaultTextStyle({ fontFamily: "Lora", fontWeight: 500 }),
      };
    });
    const { design: after, textId } = addText(design, shape.id);
    expect((after.nodes[textId] as TextNode).style).toMatchObject({
      fontFamily: "Lora",
      fontWeight: 500,
    });
  });

  it("adds a text child to a frame (filling auto-layout frames, stretching otherwise)", () => {
    const card = createFrame({ x: 40, y: 40, width: 300, height: 180 });
    const stack = createFrame({
      x: 400,
      y: 40,
      width: 300,
      height: 180,
      layout: {
        mode: "column",
        gap: 8,
        padding: [12, 12, 12, 12],
        mainAlign: "center",
        crossAlign: "center",
      },
    });
    const { design } = withNodes([card, stack]);
    const plain = addText(design, card.id);
    expect(plain.containerId).toBe(card.id);
    expect(plain.design.nodes[plain.textId]).toMatchObject({
      constraints: { h: "stretch", v: "stretch" },
    });
    const auto = addText(design, stack.id);
    expect(auto.design.nodes[auto.textId]).toMatchObject({ sizing: { h: "fill", v: "fill" } });
  });

  it("leaves other layers alone", () => {
    const image = createImage({ assetId: "asset0000001" });
    const { design } = withNodes([image]);
    expect(hostsText(design.nodes[image.id])).toBe(false);
    expect(textIntoOps(design, image.id, PAGE, ids)).toBeNull();
  });

  it("does nothing without an editable canvas", async () => {
    const shape = createRect({ x: 0, y: 0, width: 100, height: 100 });
    const { design } = withNodes([shape]);
    const fake = { design, page: PAGE, canEdit: false, client: null } as never;
    expect(await addTextInto(fake, shape.id)).toBe(false);
  });
});
