import {
  createDesign,
  createFrame,
  createGroup,
  createImage,
  createLine,
  createPath,
  createQr,
  createRect,
  createTable,
  createText,
  type Design,
  defaultTextStyle,
  type Id,
  type Transaction,
  validateDesign,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  addPage,
  alignNodes,
  applyTransaction,
  approxBounds,
  boxCorners,
  bringForward,
  bringToFront,
  childIds,
  createdIds,
  DocOpsError,
  deleteNodes,
  deletePage,
  distribute,
  duplicate,
  duplicatePage,
  getNode,
  groupNodes,
  matchSize,
  movePage,
  type Point,
  reorderPages,
  reparent,
  replaceImage,
  resizePage,
  sendBackward,
  sendToBack,
  setFill,
  setText,
  tidyGrid,
  ungroup,
  worldTransform,
  wrapInFrame,
} from "../src";

const P = "page00000001";
const P2 = "page00000002";

function fixture(): Design {
  const d = createDesign("custom", "instagram-post", { id: "dsn000000001", pageId: P, now: 0 });
  d.assets.asset0000001 = { id: "asset0000001", kind: "image", mime: "image/png" };
  const nodes = [
    createRect({ id: "recta0000001", parent: P, x: 100, y: 100, width: 100, height: 50 }),
    createRect({
      id: "rectb0000001",
      parent: P,
      x: 400,
      y: 300,
      width: 60,
      height: 60,
      rotation: 30,
    }),
    createRect({
      id: "rectc0000001",
      parent: P,
      x: 700,
      y: 50,
      width: 80,
      height: 120,
      flipX: true,
    }),
    createFrame({
      id: "frame0000001",
      parent: P,
      x: 200,
      y: 600,
      width: 400,
      height: 300,
      rotation: 15,
      children: ["inner0000001"],
    }),
    createRect({
      id: "inner0000001",
      parent: "frame0000001",
      x: 20,
      y: 30,
      width: 50,
      height: 40,
      rotation: -10,
    }),
    createText({
      id: "text00000001",
      parent: P,
      x: 50,
      y: 900,
      width: 300,
      height: 40,
      text: "Hello",
      style: defaultTextStyle({ fontSize: 32 }),
      autoResize: "none",
    }),
    createImage({
      id: "image0000001",
      parent: P,
      x: 600,
      y: 600,
      width: 200,
      height: 100,
      assetId: "asset0000001",
      crop: { x: 0, y: 0, w: 1, h: 1 },
    }),
  ];
  for (const n of nodes) d.nodes[n.id] = n;
  (d.nodes[P] as { children: Id[] }).children.push(
    "recta0000001",
    "rectb0000001",
    "rectc0000001",
    "frame0000001",
    "text00000001",
    "image0000001",
  );
  return d;
}

function apply(d: Design, tx: Transaction): Design {
  const r = applyTransaction(d, tx);
  expect(r.dropped).toEqual([]);
  expect(validateDesign(r.design).errors).toEqual([]);
  return r.design;
}

function corners(d: Design, id: Id): Point[] {
  const n = getNode(d, id);
  if (!n) throw new Error(id);
  return boxCorners(n.width, n.height, worldTransform(d, id));
}

function expectSamePlacement(a: Design, b: Design, id: Id) {
  const ca = corners(a, id);
  const cb = corners(b, id);
  ca.forEach((p, i) => {
    expect(cb[i]?.x).toBeCloseTo(p.x, 2);
    expect(cb[i]?.y).toBeCloseTo(p.y, 2);
  });
}

function expectGroupFits(d: Design, groupId: Id) {
  const g = getNode(d, groupId) as { children: Id[]; width: number; height: number };
  const kids = g.children.flatMap((c) => corners(d, c));
  const inv = worldTransform(d, groupId);
  const box = approxBounds(d, groupId);
  expect(box).toBeDefined();
  // children's corners in group-local space span exactly [0,w]x[0,h]
  const det = inv[0] * inv[3] - inv[1] * inv[2];
  const local = kids.map((p) => {
    const x = p.x - inv[4];
    const y = p.y - inv[5];
    return { x: (inv[3] * x - inv[2] * y) / det, y: (-inv[1] * x + inv[0] * y) / det };
  });
  expect(Math.min(...local.map((p) => p.x))).toBeCloseTo(0, 2);
  expect(Math.min(...local.map((p) => p.y))).toBeCloseTo(0, 2);
  expect(Math.max(...local.map((p) => p.x))).toBeCloseTo(g.width, 2);
  expect(Math.max(...local.map((p) => p.y))).toBeCloseTo(g.height, 2);
}

describe("group / ungroup / wrap", () => {
  test("grouping keeps page placement, fits bounds and sits at the top-most member's z", () => {
    const d = fixture();
    const tx = groupNodes(d, ["rectb0000001", "recta0000001", "inner0000001"], {
      groupId: "group0000001",
      ts: 1,
    });
    expect(tx.label).toBe("Group");
    const g = apply(d, tx);
    expect(createdIds(tx)).toEqual(["group0000001"]);
    // LCA of page-level rects and the frame's child is the page; the group goes above the frame (index 3 -> 4 minus moved)
    expect(childIds(g, P)).toEqual([
      "rectc0000001",
      "frame0000001",
      "group0000001",
      "text00000001",
      "image0000001",
    ]);
    expect(childIds(g, "group0000001")).toEqual(["recta0000001", "rectb0000001", "inner0000001"]);
    for (const id of ["recta0000001", "rectb0000001", "inner0000001"])
      expectSamePlacement(d, g, id);
    expectGroupFits(g, "group0000001");
    // ungroup restores placement
    const u = apply(g, ungroup(g, ["group0000001"]));
    expect(getNode(u, "group0000001")).toBeUndefined();
    for (const id of ["recta0000001", "rectb0000001", "inner0000001"])
      expectSamePlacement(d, u, id);
    expect(childIds(u, P).slice(2, 5)).toEqual(["recta0000001", "rectb0000001", "inner0000001"]);
    // undo of the group transaction restores the original exactly
    const back = applyTransaction(g, applyTransaction(d, tx).inverse).design;
    expect(back).toEqual(d);
  });

  test("grouping inside a rotated frame keeps placement", () => {
    const d = fixture();
    d.nodes.inner0000002 = createRect({
      id: "inner0000002",
      parent: "frame0000001",
      x: 200,
      y: 100,
      width: 30,
      height: 30,
      flipY: true,
    });
    (d.nodes.frame0000001 as { children: Id[] }).children.push("inner0000002");
    const g = apply(
      d,
      groupNodes(d, ["inner0000001", "inner0000002"], { groupId: "group0000001" }),
    );
    expect(getNode(g, "group0000001")?.parent).toBe("frame0000001");
    expectSamePlacement(d, g, "inner0000001");
    expectSamePlacement(d, g, "inner0000002");
    expect(getNode(g, "inner0000002")?.flipY).toBe(true);
    expectGroupFits(g, "group0000001");
  });

  test("ungroup a rotated, translucent group", () => {
    const d = fixture();
    d.nodes.group0000001 = createGroup({
      id: "group0000001",
      parent: P,
      x: 300,
      y: 300,
      width: 100,
      height: 100,
      rotation: 45,
      opacity: 0.5,
      children: ["kid000000001"],
    });
    d.nodes.kid000000001 = createRect({
      id: "kid000000001",
      parent: "group0000001",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 0.8,
    });
    (d.nodes[P] as { children: Id[] }).children.push("group0000001");
    const u = apply(d, ungroup(d, ["group0000001"]));
    expectSamePlacement(d, u, "kid000000001");
    expect(getNode(u, "kid000000001")?.rotation).toBeCloseTo(45, 6);
    expect(getNode(u, "kid000000001")?.opacity).toBeCloseTo(0.4, 6);
  });

  test("wrapInFrame with padding", () => {
    const d = fixture();
    const f = apply(
      d,
      wrapInFrame(d, ["recta0000001", "rectc0000001"], {
        frameId: "wrapwrapwrap",
        padding: 10,
        name: "Wrapper",
      }),
    );
    const frame = getNode(f, "wrapwrapwrap") as {
      x: number;
      y: number;
      width: number;
      children: Id[];
      clip: boolean;
    };
    expect(frame.children).toEqual(["recta0000001", "rectc0000001"]);
    expect(frame.x).toBeCloseTo(90, 6);
    expect(frame.y).toBeCloseTo(40, 6);
    expect(frame.width).toBeCloseTo(700, 6);
    expect(frame.clip).toBe(false);
    expectSamePlacement(d, f, "recta0000001");
    expectSamePlacement(d, f, "rectc0000001");
    expect(getNode(f, "rectc0000001")?.flipX).toBe(true);
  });

  test("invalid selections throw", () => {
    const d = fixture();
    expect(() => groupNodes(d, [])).toThrow(DocOpsError);
    expect(() => groupNodes(d, [P])).toThrow(DocOpsError);
    const two = apply(d, addPage(d, { pageId: P2 }));
    two.nodes.other0000001 = createRect({ id: "other0000001", parent: P2 });
    (two.nodes[P2] as { children: Id[] }).children.push("other0000001");
    expect(() => groupNodes(two, ["recta0000001", "other0000001"])).toThrow(/same page/);
  });
});

describe("arrange", () => {
  test("align to selection uses rotated bounds", () => {
    const d = fixture();
    const sel = ["recta0000001", "rectb0000001", "rectc0000001"];
    const left = apply(d, alignNodes(d, sel, "left"));
    const xs = sel.map((id) => approxBounds(left, id)?.x as number);
    for (const x of xs) expect(x).toBeCloseTo(100, 4);
    const bottom = apply(d, alignNodes(d, sel, "bottom"));
    const bottoms = sel.map((id) => {
      const b = approxBounds(bottom, id);
      return (b?.y as number) + (b?.height as number);
    });
    for (const y of bottoms) expect(y).toBeCloseTo(bottoms[0] as number, 4);
  });

  test("align a child of a rotated frame to the page center", () => {
    const d = fixture();
    const a = apply(d, alignNodes(d, ["inner0000001"], "center"));
    const b = approxBounds(a, "inner0000001");
    expect((b?.x as number) + (b?.width as number) / 2).toBeCloseTo(540, 4);
    const m = apply(d, alignNodes(d, ["recta0000001", "rectc0000001"], "middle", { to: "page" }));
    for (const id of ["recta0000001", "rectc0000001"]) {
      const bb = approxBounds(m, id);
      expect((bb?.y as number) + (bb?.height as number) / 2).toBeCloseTo(540, 4);
    }
  });

  test("locked nodes are not moved; already aligned yields no ops", () => {
    const d = fixture();
    (d.nodes.recta0000001 as { locked: boolean }).locked = true;
    const tx = alignNodes(d, ["recta0000001", "rectc0000001"], "left");
    expect(tx.ops.every((o) => (o as { id?: string }).id !== "recta0000001")).toBe(true);
    const once = apply(d, alignNodes(d, ["rectb0000001", "rectc0000001"], "top"));
    expect(alignNodes(once, ["rectb0000001", "rectc0000001"], "top").ops).toEqual([]);
  });

  test("distribute evenly and with fixed spacing", () => {
    const d = fixture();
    const sel = ["recta0000001", "rectb0000001", "rectc0000001"];
    const even = apply(d, distribute(d, sel, "horizontal"));
    const boxes = sel
      .map((id) => approxBounds(even, id) as { x: number; width: number })
      .sort((a, b) => a.x - b.x);
    const gap1 = (boxes[1]?.x as number) - ((boxes[0]?.x as number) + (boxes[0]?.width as number));
    const gap2 = (boxes[2]?.x as number) - ((boxes[1]?.x as number) + (boxes[1]?.width as number));
    expect(gap1).toBeCloseTo(gap2, 4);
    const fixed = apply(d, distribute(d, sel, "vertical", { spacing: 20 }));
    const v = sel
      .map((id) => approxBounds(fixed, id) as { y: number; height: number })
      .sort((a, b) => a.y - b.y);
    expect((v[1]?.y as number) - ((v[0]?.y as number) + (v[0]?.height as number))).toBeCloseTo(
      20,
      4,
    );
    expect(distribute(d, sel.slice(0, 2), "horizontal").ops).toEqual([]);
  });

  test("tidyGrid places nodes into equal cells", () => {
    const d = fixture();
    const sel = ["recta0000001", "rectb0000001", "rectc0000001", "text00000001"];
    const t = apply(d, tidyGrid(d, sel, { columns: 2, gap: 10 }));
    const boxes = sel.map(
      (id) => approxBounds(t, id) as { x: number; y: number; width: number; height: number },
    );
    const centersX = new Set(boxes.map((b) => Math.round((b.x + b.width / 2) * 100)));
    const centersY = new Set(boxes.map((b) => Math.round((b.y + b.height / 2) * 100)));
    expect(centersX.size).toBe(2);
    expect(centersY.size).toBe(2);
    expect(tidyGrid(d, ["recta0000001"]).ops).toEqual([]);
  });

  test("matchSize keeps centers", () => {
    const d = fixture();
    const m = apply(d, matchSize(d, ["recta0000001", "rectc0000001"], { to: "largest" }));
    expect(getNode(m, "recta0000001")?.width).toBe(80);
    expect(getNode(m, "recta0000001")?.height).toBe(120);
    expect(getNode(m, "recta0000001")?.x).toBe(110);
    expect(getNode(m, "recta0000001")?.y).toBe(65);
    const w = apply(
      d,
      matchSize(d, ["recta0000001", "rectc0000001"], { dimension: "width", to: "rectc0000001" }),
    );
    expect(getNode(w, "recta0000001")?.width).toBe(80);
    expect(getNode(w, "recta0000001")?.height).toBe(50);
    expect(() => matchSize(d, ["recta0000001"], { to: "missingmissi" })).toThrow();
    d.nodes.line00000001 = createLine({ id: "line00000001", parent: P, width: 10 });
    (d.nodes[P] as { children: Id[] }).children.push("line00000001");
    const l = apply(d, matchSize(d, ["recta0000001", "line00000001"]));
    expect(getNode(l, "line00000001")?.height).toBe(0);
    expect(getNode(l, "line00000001")?.width).toBe(100);
  });

  test("z-order", () => {
    const d = fixture();
    const order = (x: Design) => childIds(x, P);
    expect(order(apply(d, bringForward(d, ["recta0000001"])))).toEqual([
      "rectb0000001",
      "recta0000001",
      "rectc0000001",
      "frame0000001",
      "text00000001",
      "image0000001",
    ]);
    expect(order(apply(d, sendBackward(d, ["rectc0000001"])))).toEqual([
      "recta0000001",
      "rectc0000001",
      "rectb0000001",
      "frame0000001",
      "text00000001",
      "image0000001",
    ]);
    expect(order(apply(d, bringToFront(d, ["recta0000001", "rectc0000001"])))).toEqual([
      "rectb0000001",
      "frame0000001",
      "text00000001",
      "image0000001",
      "recta0000001",
      "rectc0000001",
    ]);
    expect(order(apply(d, sendToBack(d, ["image0000001", "text00000001"])))).toEqual([
      "text00000001",
      "image0000001",
      "recta0000001",
      "rectb0000001",
      "rectc0000001",
      "frame0000001",
    ]);
    expect(bringToFront(d, ["image0000001"]).ops).toEqual([]);
    expect(sendToBack(d, ["recta0000001"]).ops).toEqual([]);
    // selected block moves together
    expect(order(apply(d, bringForward(d, ["recta0000001", "rectb0000001"])))).toEqual([
      "rectc0000001",
      "recta0000001",
      "rectb0000001",
      "frame0000001",
      "text00000001",
      "image0000001",
    ]);
  });
});

describe("structure", () => {
  test("duplicate places copies above originals with offsets", () => {
    const d = fixture();
    const tx = duplicate(d, ["recta0000001", "frame0000001", "inner0000001"]);
    const out = apply(d, tx);
    const created = createdIds(tx);
    expect(created).toHaveLength(2);
    const kids = childIds(out, P);
    expect(kids[kids.indexOf("recta0000001") + 1]).toBe(created[0]);
    expect(kids[kids.indexOf("frame0000001") + 1]).toBe(created[1]);
    expect(getNode(out, created[0] as Id)?.x).toBe(116);
    expect(childIds(out, created[1] as Id)).toHaveLength(1);
    expect(duplicate(d, ["recta0000001"], { offset: { x: 0, y: 0 } }).label).toBe("Duplicate");
  });

  test("deleteNodes removes groups left empty", () => {
    const d = fixture();
    const g = apply(
      d,
      groupNodes(d, ["recta0000001", "rectb0000001"], { groupId: "group0000001" }),
    );
    const del = apply(g, deleteNodes(g, ["recta0000001", "rectb0000001"]));
    expect(getNode(del, "group0000001")).toBeUndefined();
    const partial = apply(g, deleteNodes(g, ["rectb0000001"]));
    expectGroupFits(partial, "group0000001");
    expectSamePlacement(d, partial, "recta0000001");
    expect(deleteNodes(d, ["root"]).ops).toEqual([]);
    expect(() => deleteNodes(d, childIds(d, "root"))).toThrow(/at least one page/);
    expect(() => deleteNodes(d, [...childIds(d, "root"), "recta0000001"])).toThrow(DocOpsError);
  });

  test("reparent keeps placement across rotated containers", () => {
    const d = fixture();
    const r = apply(d, reparent(d, ["recta0000001", "rectb0000001"], "frame0000001", { index: 0 }));
    expect(childIds(r, "frame0000001")).toEqual(["recta0000001", "rectb0000001", "inner0000001"]);
    expectSamePlacement(d, r, "recta0000001");
    expectSamePlacement(d, r, "rectb0000001");
    const out = apply(r, reparent(r, ["inner0000001"], P));
    expectSamePlacement(d, out, "inner0000001");
    const raw = apply(d, reparent(d, ["recta0000001"], "frame0000001", { keepPosition: false }));
    expect(getNode(raw, "recta0000001")?.x).toBe(100);
    expect(() => reparent(d, ["frame0000001"], "inner0000001")).toThrow(/not a container/);
    expect(() => reparent(d, ["frame0000001"], "frame0000001")).toThrow(/into itself/);
    expect(() => reparent(d, ["recta0000001"], "root")).toThrow(/pages/);
  });
});

describe("edits", () => {
  test("setFill per node type", () => {
    const d = fixture();
    d.nodes.line00000001 = createLine({ id: "line00000001", parent: P, strokes: [] });
    d.nodes.qr0000000001 = createQr({ id: "qr0000000001", parent: P });
    d.nodes.table0000001 = createTable({ id: "table0000001", parent: P });
    (d.nodes.text00000001 as { runs: unknown[] }).runs = [
      { text: "a", style: { fills: [{ type: "solid", color: "#000000" }], fontWeight: 700 } },
      { text: "b", style: { fills: [] } },
    ];
    (d.nodes[P] as { children: Id[] }).children.push(
      "line00000001",
      "qr0000000001",
      "table0000001",
    );
    const fill = { type: "solid" as const, color: "#ff6a1f" };
    const out = apply(
      d,
      setFill(
        d,
        [
          "recta0000001",
          "text00000001",
          P,
          "line00000001",
          "qr0000000001",
          "table0000001",
          "frame0000001",
          "missingmissi",
        ],
        fill,
      ),
    );
    expect((getNode(out, "recta0000001") as { fills: unknown }).fills).toEqual([fill]);
    expect((getNode(out, "text00000001") as { style: { fills: unknown } }).style.fills).toEqual([
      fill,
    ]);
    expect((getNode(out, "text00000001") as { runs: unknown }).runs).toEqual([
      { text: "a", style: { fontWeight: 700 } },
      { text: "b" },
    ]);
    expect((getNode(out, P) as { background: unknown }).background).toEqual([fill]);
    expect(
      (getNode(out, "line00000001") as { strokes: { fills: unknown }[] }).strokes[0]?.fills,
    ).toEqual([fill]);
    expect((getNode(out, "qr0000000001") as { fg: string }).fg).toBe("#ff6a1f");
    expect(getNode(out, "table0000001")).toEqual(getNode(d, "table0000001"));
    const g = apply(
      d,
      groupNodes(d, ["recta0000001", "rectb0000001"], { groupId: "group0000001" }),
    );
    const viaGroup = apply(g, setFill(g, ["group0000001"], [fill]));
    expect((getNode(viaGroup, "rectb0000001") as { fills: unknown }).fills).toEqual([fill]);
  });

  test("setText", () => {
    const d = fixture();
    (d.nodes.text00000001 as { runs: unknown[] }).runs = [
      { text: "x", style: { fontWeight: 700 } },
    ];
    const out = apply(d, setText(d, "text00000001", "New\ncopy"));
    expect((getNode(out, "text00000001") as { runs: unknown }).runs).toEqual([
      { text: "New\ncopy", style: { fontWeight: 700 } },
    ]);
    const plain = apply(d, setText(d, "text00000001", "Plain", { keepRunStyle: false }));
    expect((getNode(plain, "text00000001") as { runs: unknown }).runs).toEqual([{ text: "Plain" }]);
    expect(() => setText(d, "recta0000001", "x")).toThrow(DocOpsError);
  });

  test("replaceImage", () => {
    const d = fixture();
    const asset = { id: "asset0000002", kind: "image" as const, mime: "image/webp" };
    const out = apply(d, replaceImage(d, "image0000001", "asset0000002", { asset }));
    expect(getNode(out, "image0000001")).toMatchObject({ assetId: "asset0000002" });
    expect((getNode(out, "image0000001") as { crop?: unknown }).crop).toBeUndefined();
    expect(out.assets.asset0000002).toEqual(asset);
    (d.nodes.recta0000001 as { fills: unknown[] }).fills = [
      { type: "solid", color: "#000000" },
      { type: "image", assetId: "asset0000001", mode: "fill" },
    ];
    const shape = apply(d, replaceImage(d, "recta0000001", "asset0000001"));
    expect((getNode(shape, "recta0000001") as { fills: unknown[] }).fills[1]).toEqual({
      type: "image",
      assetId: "asset0000001",
      mode: "fill",
    });
    expect(() => replaceImage(d, "rectb0000001", "asset0000001")).toThrow(/no image/);
    expect(() => replaceImage(d, P, "asset0000001")).toThrow(/no image background/);
    expect(() => replaceImage(d, "image0000001", "x", { asset })).toThrow(/asset.id/);
  });
});

describe("pages", () => {
  test("add / duplicate / move / reorder / delete", () => {
    const d = fixture();
    const a = apply(d, addPage(d, { pageId: P2 }));
    expect(childIds(a, "root")).toEqual([P, P2]);
    expect(getNode(a, P2)).toMatchObject({ width: 1080, height: 1080, name: "Page 2" });
    const preset = apply(a, addPage(a, { preset: "poster-a4", index: 0, pageId: "page00000003" }));
    expect(childIds(preset, "root")).toEqual(["page00000003", P, P2]);
    expect(getNode(preset, "page00000003")).toMatchObject({ unit: "mm" });
    expect(() => addPage(a, { preset: "nope" })).toThrow();
    expect(() => addPage(a, { like: "recta0000001" })).toThrow();
    const dupTx = duplicatePage(a, P);
    const dup = apply(a, dupTx);
    const copy = createdIds(dupTx)[0] as Id;
    expect(childIds(dup, "root")).toEqual([P, copy, P2]);
    expect(getNode(dup, copy)?.name).toBe("Page 1 copy");
    expect(childIds(dup, copy)).toHaveLength(childIds(a, P).length);
    const moved = apply(dup, movePage(dup, P, 2));
    expect(childIds(moved, "root")).toEqual([copy, P2, P]);
    const re = apply(moved, reorderPages(moved, [P, copy, P2]));
    expect(childIds(re, "root")).toEqual([P, copy, P2]);
    expect(() => reorderPages(moved, [P])).toThrow();
    const del = apply(re, deletePage(re, copy));
    expect(childIds(del, "root")).toEqual([P, P2]);
    expect(() => deletePage(d, P)).toThrow(/at least one page/);
    expect(() => deletePage(d, "recta0000001")).toThrow();
  });

  test("resizePage scale: uniform, centered, sizes follow", () => {
    const d = fixture();
    d.nodes.path00000001 = createPath({
      id: "path00000001",
      parent: P,
      width: 100,
      height: 100,
      paths: [{ d: "M0 0L100 0L100 100Z", fillRule: "nonzero" }],
      cornerRadius: 8,
    });
    (d.nodes[P] as { children: Id[] }).children.push("path00000001");
    const out = apply(d, resizePage(d, P, { width: 1080, height: 1920 }));
    expect(getNode(out, P)).toMatchObject({ width: 1080, height: 1920 });
    // s = 1, content centered vertically: offset (1920-1080)/2 = 420
    expect(getNode(out, "recta0000001")).toMatchObject({ x: 100, y: 520, width: 100 });
    const half = apply(d, resizePage(d, P, { width: 540, height: 540 }));
    expect(getNode(half, "recta0000001")).toMatchObject({ x: 50, y: 50, width: 50, height: 25 });
    expect(getNode(half, "inner0000001")).toMatchObject({ x: 10, y: 15, width: 25, height: 20 });
    expect((getNode(half, "text00000001") as { style: { fontSize: number } }).style.fontSize).toBe(
      16,
    );
    expect((getNode(half, "path00000001") as { paths: { d: string }[] }).paths[0]?.d).toBe(
      "M0 0L50 0L50 50Z",
    );
    expect((getNode(half, "path00000001") as { cornerRadius: number }).cornerRadius).toBe(4);
  });

  test("resizePage stretch / fill / center / none", () => {
    const d = fixture();
    const stretch = apply(
      d,
      resizePage(d, P, { width: 2160, height: 1080 }, { strategy: "stretch" }),
    );
    expect(getNode(stretch, "recta0000001")).toMatchObject({
      x: 200,
      y: 100,
      width: 200,
      height: 50,
    });
    expect(
      (getNode(stretch, "text00000001") as { style: { fontSize: number } }).style.fontSize,
    ).toBe(32);
    const fill = apply(d, resizePage(d, P, { width: 2160, height: 1080 }, { strategy: "fill" }));
    expect(getNode(fill, "recta0000001")).toMatchObject({ x: 200, y: -340, width: 200 });
    const center = apply(
      d,
      resizePage(d, P, { width: 1280, height: 1080 }, { strategy: "center" }),
    );
    expect(getNode(center, "recta0000001")).toMatchObject({ x: 200, y: 100, width: 100 });
    const none = apply(
      d,
      resizePage(d, P, { width: 10, height: 10 }, { strategy: "none", unit: "mm" }),
    );
    expect(getNode(none, "recta0000001")).toEqual(getNode(d, "recta0000001"));
    expect(getNode(none, P)).toMatchObject({ width: 10, height: 10, unit: "mm" });
    expect(() => resizePage(d, P, { width: 0, height: 10 })).toThrow();
    expect(() => resizePage(d, "recta0000001", { width: 10, height: 10 })).toThrow();
  });

  test("resizePage keeps unparsable path data instead of failing", () => {
    const d = fixture();
    d.nodes.path00000002 = createPath({
      id: "path00000002",
      parent: P,
      paths: [
        { d: "M0 0 L oops", fillRule: "nonzero" },
        { d: "M0 0H100", fillRule: "evenodd" },
      ],
    });
    (d.nodes[P] as { children: Id[] }).children.push("path00000002");
    const half = apply(d, resizePage(d, P, { width: 540, height: 540 }));
    const paths = (getNode(half, "path00000002") as { paths: { d: string }[] }).paths;
    expect(paths.map((p) => p.d)).toEqual(["M0 0 L oops", "M0 0H50"]);
  });
});

describe("builder performance", () => {
  // Builders apply each op to one working copy; re-copying the node map per op made these quadratic
  // (seconds for a few thousand nodes).
  test("builders stay fast on a page with 5000 nodes", () => {
    const d = createDesign("custom", "instagram-post", { id: "dsn000000001", pageId: P, now: 0 });
    const ids: Id[] = [];
    for (let i = 0; i < 5000; i++) {
      const id = `r${String(i).padStart(11, "0")}`;
      d.nodes[id] = createRect({ id, parent: P, x: i % 100, y: i % 977 });
      ids.push(id);
    }
    (d.nodes[P] as { children: Id[] }).children = ids;
    const start = performance.now();
    const resized = resizePage(d, P, { width: 2160, height: 2160 });
    const aligned = alignNodes(d, ids, "left");
    const copies = duplicate(d, ids.slice(0, 2000));
    const grouped = groupNodes(d, ids.slice(0, 2000));
    const elapsed = performance.now() - start;
    expect(resized.ops.length).toBe(5001);
    expect(aligned.ops.length).toBe(4950);
    expect(createdIds(copies)).toHaveLength(2000);
    expect(grouped.ops.length).toBeGreaterThan(2000);
    expect(elapsed).toBeLessThan(3000);
  });
});
