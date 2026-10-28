// Property tests for the structural builders on random nested designs with rotated / flipped containers:
// every builder must produce a transaction that applies cleanly, keeps the design valid, and keeps every node
// that it does not mean to move exactly where it was on the page.
import {
  type Design,
  type Id,
  isContainerType,
  type Node,
  type Transaction,
  validateDesign,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  alignNodes,
  applyTransaction,
  deleteNodes,
  descendants,
  distribute,
  duplicate,
  getNode,
  groupNodes,
  isAncestor,
  type Matrix,
  pageOf,
  pages,
  reparent,
  ungroup,
  worldTransform,
  wrapInFrame,
} from "../src";
import { int, pick, randomDesign, rng } from "./helpers";

/** Random design whose containers are rotated and flipped too (randomDesign only rotates leaves). */
function twistedDesign(seed: number): Design {
  const d = randomDesign(seed);
  const r = rng(seed * 7919);
  for (const node of Object.values(d.nodes)) {
    if (node.type !== "frame" && node.type !== "group") continue;
    const n = node as Node;
    n.rotation = pick(r, [0, 0, 20, -45, 90, 135]);
    if (r() < 0.3) n.flipX = true;
    if (r() < 0.2) n.flipY = true;
  }
  return d;
}

function apply(d: Design, tx: Transaction): Design {
  const r = applyTransaction(d, tx);
  expect(r.dropped).toEqual([]);
  const v = validateDesign(r.design);
  expect(v.errors).toEqual([]);
  return r.design;
}

function expectSamePlacement(a: Design, b: Design, ids: Iterable<Id>, label: string) {
  for (const id of ids) {
    const before = getNode(a, id);
    const after = getNode(b, id);
    // Group boxes are derived (refit to their children), so only their children's placement is compared.
    if (!before || !after || ["page", "root", "group"].includes(before.type)) continue;
    const ma = worldTransform(a, id);
    const mb = worldTransform(b, id);
    // Box corners (not only the matrix) so a size change would show too.
    const corners = (m: Matrix, w: number, h: number) =>
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ].map(([x, y]) => [
        m[0] * (x as number) + m[2] * (y as number) + m[4],
        m[1] * (x as number) + m[3] * (y as number) + m[5],
      ]);
    const ca = corners(ma, before.width, before.height).flat();
    const cb = corners(mb, after.width, after.height).flat();
    for (let i = 0; i < ca.length; i++) {
      expect(Math.abs((ca[i] as number) - (cb[i] as number)), `${label}: ${id}`).toBeLessThan(0.01);
    }
  }
}

/** Non-page nodes of one page that are not group/frame descendants of each other. */
function randomSelection(d: Design, seed: number, max: number): Id[] {
  const r = rng(seed);
  const page = pick(r, pages(d));
  const all = descendants(d, page.id).map((n) => n.id);
  if (all.length === 0) return [];
  const out: Id[] = [];
  const count = int(r, 1, Math.min(max, all.length));
  for (let i = 0; i < count * 3 && out.length < count; i++) {
    const id = pick(r, all);
    if (out.includes(id) || out.some((o) => isAncestor(d, o, id) || isAncestor(d, id, o))) continue;
    out.push(id);
  }
  return out;
}

const allIds = (d: Design) => Object.keys(d.nodes);

describe("structural builders keep page placement (random rotated/flipped trees)", () => {
  test("groupNodes / wrapInFrame", () => {
    let checked = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const d = twistedDesign(seed);
      const sel = randomSelection(d, seed, 4);
      if (sel.length === 0) continue;
      const g = apply(d, groupNodes(d, sel, { groupId: "grp000000new" }));
      expect((getNode(g, "grp000000new") as { children: Id[] }).children.sort()).toEqual(
        [...sel].sort(),
      );
      expectSamePlacement(d, g, allIds(d), `group seed ${seed}`);
      const f = apply(d, wrapInFrame(d, sel, { frameId: "frm000000new", padding: 8 }));
      expectSamePlacement(d, f, allIds(d), `frame seed ${seed}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("ungroup", () => {
    let checked = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const d = twistedDesign(seed);
      const containers = Object.values(d.nodes).filter(
        (n) => (n.type === "group" || n.type === "frame") && n.opacity === 1,
      );
      if (containers.length === 0) continue;
      const target = pick(rng(seed), containers);
      const out = apply(d, ungroup(d, [target.id]));
      expect(getNode(out, target.id)).toBeUndefined();
      expectSamePlacement(d, out, allIds(d), `ungroup seed ${seed}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("reparent", () => {
    let checked = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const d = twistedDesign(seed);
      const sel = randomSelection(d, seed + 1000, 3);
      if (sel.length === 0) continue;
      const page = pageOf(d, sel[0] as Id) as Node;
      const targets = [page, ...descendants(d, page.id)].filter(
        (n) =>
          isContainerType(n.type) &&
          !sel.some((s) => s === n.id || isAncestor(d, s, n.id)) &&
          n.type !== "root",
      );
      const target = pick(rng(seed + 5), targets);
      const out = apply(d, reparent(d, sel, target.id));
      for (const id of sel) expect(getNode(out, id)?.parent).toBe(target.id);
      expectSamePlacement(d, out, allIds(d), `reparent seed ${seed}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("duplicate / delete / align / distribute keep the rest in place", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const d = twistedDesign(seed);
      const sel = randomSelection(d, seed + 2000, 4);
      if (sel.length === 0) continue;
      const dup = apply(d, duplicate(d, sel));
      expectSamePlacement(d, dup, allIds(d), `duplicate seed ${seed}`);
      const del = apply(d, deleteNodes(d, sel));
      for (const id of sel) expect(getNode(del, id)).toBeUndefined();
      const untouched = allIds(d).filter(
        (id) => !sel.some((s) => s === id || isAncestor(d, s, id)),
      );
      expectSamePlacement(d, del, untouched, `delete seed ${seed}`);
      const unlocked = sel.filter((id) => !getNode(d, id)?.locked);
      const aligned = apply(d, alignNodes(d, unlocked, "center"));
      const others = allIds(d).filter(
        (id) => !unlocked.some((s) => s === id || isAncestor(d, s, id)),
      );
      expectSamePlacement(d, aligned, others, `align seed ${seed}`);
      apply(d, distribute(d, unlocked, "vertical", { spacing: 12 }));
    }
  });
});
