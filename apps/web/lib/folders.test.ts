import { describe, expect, it } from "vitest";
import { buildFolderTree, folderPath, wouldCycle } from "./folders";

const folders = [
  { id: "a", name: "A", parentId: null },
  { id: "b", name: "B", parentId: "a" },
  { id: "c", name: "C", parentId: "b" },
  { id: "d", name: "D", parentId: null },
  { id: "o", name: "Orphan", parentId: "missing" },
];

describe("folders", () => {
  it("nests folders and keeps orphans at the root", () => {
    const tree = buildFolderTree(folders);
    expect(tree.map((n) => n.folder.id)).toEqual(["a", "d", "o"]);
    expect(tree[0]?.children[0]?.children[0]?.folder.id).toBe("c");
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });
  it("builds breadcrumb paths", () => {
    expect(folderPath(folders, "c").map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(folderPath(folders, null)).toEqual([]);
  });
  it("detects cycles", () => {
    expect(wouldCycle(folders, "a", "c")).toBe(true);
    expect(wouldCycle(folders, "a", "a")).toBe(true);
    expect(wouldCycle(folders, "c", "d")).toBe(false);
    expect(wouldCycle(folders, "b", null)).toBe(false);
  });
});
