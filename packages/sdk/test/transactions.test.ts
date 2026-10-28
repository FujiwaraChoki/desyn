import { applyTransaction } from "@desyn/doc-ops";
import {
  createDesign,
  type Design,
  type FrameNode,
  type TextNode,
  validateDesign,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  expandNode,
  NodeInputError,
  normalizeOps,
  TransactionBuilder,
  toTransaction,
} from "../src";

function firstPage(design: Design): string {
  return (design.nodes.root as { children: string[] }).children[0] as string;
}

describe("NodeInput expansion", () => {
  test("nested children become one subtree with parent links and valid nodes", () => {
    const design = createDesign("poster");
    const page = firstPage(design);
    const nodes = expandNode(
      {
        type: "frame",
        name: "Card",
        fill: "#1d1a16",
        children: [
          {
            type: "text",
            text: "Hi",
            fontSize: 40,
            color: "#ffb02e",
            align: "center",
            lineHeight: 1.2,
          },
          { type: "group", children: [{ type: "ellipse", fill: "#ffffff" }] },
        ],
      },
      page,
    );
    expect(nodes).toHaveLength(4);
    const [frame, text, group, ellipse] = nodes as [
      FrameNode,
      TextNode,
      FrameNode,
      { parent: string; fills: unknown },
    ];
    expect(frame.parent).toBe(page);
    expect(frame.children).toEqual([text.id, group.id]);
    expect(frame.fills).toEqual([{ type: "solid", color: "#1d1a16" }]);
    expect(text.parent).toBe(frame.id);
    expect(text.runs).toEqual([{ text: "Hi" }]);
    expect(text.style).toMatchObject({
      fontSize: 40,
      fills: [{ type: "solid", color: "#ffb02e" }],
    });
    expect(text.paragraph).toMatchObject({
      align: "center",
      lineHeight: { unit: "percent", value: 120 },
    });
    expect(group.children).toEqual([ellipse && (nodes[3] as { id: string }).id]);
    expect(ellipse.parent).toBe(group.id);

    const tx = toTransaction({ ops: [{ op: "create", parent: page, nodes }] });
    const result = applyTransaction(design, tx);
    expect(result.dropped).toEqual([]);
    expect(validateDesign(result.design).ok).toBe(true);
  });

  test("errors name the problem", () => {
    expect(() => expandNode({ type: "image" } as never, "p")).toThrow(/assetId/);
    expect(() => expandNode({ type: "svg" } as never, "p")).toThrow(/assetId or markup/);
    expect(() => expandNode({ type: "rect", children: [{ type: "rect" }] }, "p")).toThrow(
      /cannot have children/,
    );
    expect(() => expandNode({ type: "bogus" } as never, "p")).toThrow(NodeInputError);
    expect(() => expandNode({ type: "rect", id: "NOPE" }, "p")).toThrow(/12 characters/);
    expect(() =>
      expandNode(
        {
          type: "group",
          children: [
            { type: "rect", id: "aaaaaaaaaaaa" },
            { type: "rect", id: "aaaaaaaaaaaa" },
          ],
        },
        "p",
      ),
    ).toThrow(/Duplicate/);
  });

  test("normalizeOps expands `node` and keeps other ops as they are", () => {
    const ops = normalizeOps([
      { op: "create", parent: "pppppppppppp", node: { type: "rect", fill: "#ff0000" }, index: 0 },
      { op: "update", id: "xxxxxxxxxxxx", set: { x: 1 } },
    ]);
    expect(ops[0]).toMatchObject({ op: "create", parent: "pppppppppppp", index: 0 });
    expect((ops[0] as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(ops[1]).toEqual({ op: "update", id: "xxxxxxxxxxxx", set: { x: 1 } });
    expect(() => normalizeOps([{ op: "create", node: { type: "rect" } }])).toThrow(
      /ops\[0\].*parent/,
    );
  });
});

describe("TransactionBuilder", () => {
  test("builds every op kind and applies cleanly", () => {
    const design = createDesign("poster");
    const page = firstPage(design);
    const b = new TransactionBuilder();
    const box = b.create(page, { type: "rect", name: "Box", fill: "#123456" });
    const label = b.create(page, { type: "text", text: "Label" }, { index: 0 });
    b.update(box, { x: 10 }, ["role"])
      .patch(box, ["fills", 0, "color"], "#654321")
      .move(label, page)
      .asset([{ id: "img000000001", kind: "image", mime: "image/png" }])
      .styles(["colors", "c00000000001"], { name: "Ink", value: "#111111" })
      .doc({ name: "Renamed" })
      .delete(label);
    const input = b.build("Everything", { source: "ai", agent: "test" });
    expect(input.actor).toEqual({ agent: "test" });
    const result = applyTransaction(design, toTransaction(input));
    expect(result.dropped).toEqual([]);
    expect(result.design.name).toBe("Renamed");
    expect(result.design.nodes[box]).toMatchObject({
      x: 10,
      fills: [{ type: "solid", color: "#654321" }],
    });
    expect(result.design.nodes[label]).toBeUndefined();
    expect(result.design.assets.img000000001).toBeDefined();
    expect(() => new TransactionBuilder().build("Empty")).toThrow();
  });
});
