import { describe, expect, it } from "vitest";
import {
  allIds,
  flattenTree,
  moveTreeNodes,
  rangeBetween,
  resolveDrop,
  type TreeNode,
  typeaheadMatch,
} from "../src/lib/tree.ts";

/*
 * page
 * ├─ header (group)
 * │  ├─ title
 * │  └─ subtitle
 * ├─ photo
 * └─ cta (group, empty)
 * notes
 */
const tree: TreeNode<string>[] = [
  {
    id: "page",
    data: "Page",
    children: [
      {
        id: "header",
        data: "Header",
        children: [
          { id: "title", data: "Title" },
          { id: "subtitle", data: "Subtitle" },
        ],
      },
      { id: "photo", data: "Photo" },
      { id: "cta", data: "Call to action", children: [] },
    ],
  },
  { id: "notes", data: "Notes" },
];

const childIds = (nodes: TreeNode<string>[], id: string | null): string[] => {
  if (id === null) return nodes.map((n) => n.id);
  const find = (list: TreeNode<string>[]): TreeNode<string> | undefined => {
    for (const n of list) {
      if (n.id === id) return n;
      const f = n.children ? find(n.children) : undefined;
      if (f) return f;
    }
    return undefined;
  };
  return (find(nodes)?.children ?? []).map((n) => n.id);
};

describe("flattenTree", () => {
  it("lists only rows under expanded parents, with depth and position", () => {
    const flat = flattenTree(tree, new Set(["page"]));
    expect(flat.map((f) => `${f.id}@${f.depth}`)).toEqual([
      "page@0",
      "header@1",
      "photo@1",
      "cta@1",
      "notes@0",
    ]);
    const header = flat.find((f) => f.id === "header");
    expect(header).toMatchObject({
      parentId: "page",
      index: 0,
      siblingCount: 3,
      hasChildren: true,
      isExpanded: false,
    });
    // Empty containers have no expandable children.
    expect(flat.find((f) => f.id === "cta")?.hasChildren).toBe(false);
  });

  it("lists every id depth-first", () => {
    expect(allIds(tree)).toEqual(["page", "header", "title", "subtitle", "photo", "cta", "notes"]);
  });
});

describe("resolveDrop", () => {
  const expanded = new Set(["page", "header"]);
  const flat = flattenTree(tree, expanded);
  // rows: 0 page, 1 header, 2 title, 3 subtitle, 4 photo, 5 cta, 6 notes
  const at = (id: string) => flat.findIndex((f) => f.id === id);

  it("drops before/after leaves at their midpoint", () => {
    expect(resolveDrop(flat, tree, at("photo"), 0.3, ["notes"])).toMatchObject({
      position: "before",
      parentId: "page",
      index: 1,
    });
    expect(resolveDrop(flat, tree, at("photo"), 0.7, ["notes"])).toMatchObject({
      position: "after",
      parentId: "page",
      index: 2,
    });
  });

  it("drops inside containers in their middle band", () => {
    expect(resolveDrop(flat, tree, at("cta"), 0.5, ["photo"])).toMatchObject({
      position: "inside",
      parentId: "cta",
      index: 0,
      depth: 2,
    });
  });

  it("treats 'after' an expanded container as its first child", () => {
    expect(resolveDrop(flat, tree, at("header"), 0.9, ["photo"])).toMatchObject({
      position: "inside",
      parentId: "header",
      index: 0,
    });
  });

  it("compensates for dragged siblings above the insertion point", () => {
    // Moving title below subtitle: raw index 2, minus title itself -> 1.
    expect(resolveDrop(flat, tree, at("subtitle"), 0.8, ["title"])).toMatchObject({
      parentId: "header",
      index: 1,
    });
  });

  it("rejects drops into the dragged node's own subtree or onto itself", () => {
    expect(resolveDrop(flat, tree, at("title"), 0.3, ["header"])).toBeNull();
    expect(resolveDrop(flat, tree, at("header"), 0.5, ["page"])).toBeNull();
    expect(resolveDrop(flat, tree, at("photo"), 0.2, ["photo"])).toBeNull();
  });

  it("outdents below the end of a subtree when the pointer moves left", () => {
    // Below "subtitle" (last child of header): pointer deep -> stays inside header.
    expect(
      resolveDrop(flat, tree, at("subtitle"), 0.8, ["notes"], { pointerDepth: 5 }),
    ).toMatchObject({ targetId: "subtitle", parentId: "header", index: 2, depth: 2, line: 4 });
    // Pointer at depth 1 -> after header inside page; the line stays under "subtitle".
    expect(
      resolveDrop(flat, tree, at("subtitle"), 0.8, ["notes"], { pointerDepth: 1 }),
    ).toMatchObject({ targetId: "header", parentId: "page", index: 1, depth: 1, line: 4 });
    // Below the very last row with the pointer at the far left -> end of the root list.
    const last = flattenTree(tree, new Set(["page"]));
    // rows: page, header, photo, cta, notes; drag the last child of page out of it.
    expect(
      resolveDrop(
        last,
        tree,
        last.findIndex((f) => f.id === "cta"),
        0.9,
        ["cta"],
        {
          pointerDepth: 0,
        },
      ),
    ).toMatchObject({ targetId: "page", parentId: null, index: 1, depth: 0, line: 4 });
    // Without outdenting, dropping the last child after itself is a no-op and rejected.
    expect(
      resolveDrop(
        last,
        tree,
        last.findIndex((f) => f.id === "cta"),
        0.9,
        ["cta"],
        {
          pointerDepth: 1,
        },
      ),
    ).toBeNull();
    // Rows that are not the last sibling never outdent.
    expect(resolveDrop(flat, tree, at("title"), 0.8, ["notes"], { pointerDepth: 0 })).toMatchObject(
      { parentId: "header", index: 1 },
    );
  });

  it("honours canHaveChildren and canDrop", () => {
    const noContainers = resolveDrop(flat, tree, at("cta"), 0.5, ["photo"], {
      canHaveChildren: () => false,
    });
    expect(noContainers?.position).toBe("after");
    const veto = resolveDrop(flat, tree, at("photo"), 0.3, ["notes"], { canDrop: () => false });
    expect(veto).toBeNull();
  });
});

describe("moveTreeNodes", () => {
  it("reorders within a parent using post-removal indexes", () => {
    const next = moveTreeNodes(tree, ["title"], "header", 1);
    expect(childIds(next, "header")).toEqual(["subtitle", "title"]);
  });

  it("reparents and keeps visual order for multiple nodes", () => {
    const next = moveTreeNodes(tree, ["photo", "title"], "cta", 0);
    expect(childIds(next, "cta")).toEqual(["title", "photo"]);
    expect(childIds(next, "header")).toEqual(["subtitle"]);
    expect(childIds(next, "page")).toEqual(["header", "cta"]);
  });

  it("moves to the root level and clamps the index", () => {
    const next = moveTreeNodes(tree, ["photo"], null, 99);
    expect(childIds(next, null)).toEqual(["page", "notes", "photo"]);
  });

  it("skips moves into a node's own subtree and drops descendants of moved ancestors", () => {
    expect(moveTreeNodes(tree, ["header"], "title", 0)).toBe(tree);
    const next = moveTreeNodes(tree, ["header", "title"], null, 0);
    expect(childIds(next, null)).toEqual(["header", "page", "notes"]);
    expect(childIds(next, "header")).toEqual(["title", "subtitle"]);
  });

  it("does not mutate the input", () => {
    const snapshot = JSON.stringify(tree);
    moveTreeNodes(tree, ["photo"], "header", 0);
    expect(JSON.stringify(tree)).toBe(snapshot);
  });
});

describe("selection helpers", () => {
  const flat = flattenTree(tree, new Set(["page", "header"]));

  it("selects ranges in visual order", () => {
    expect(rangeBetween(flat, "photo", "title")).toEqual(["title", "subtitle", "photo"]);
  });

  it("finds type-ahead matches with wrap-around", () => {
    const label = (n: TreeNode<string>) => n.data ?? "";
    expect(typeaheadMatch(flat, 0, "s", label)).toBe(3);
    expect(typeaheadMatch(flat, 4, "p", label)).toBe(0);
    expect(typeaheadMatch(flat, 0, "zzz", label)).toBe(-1);
  });
});
