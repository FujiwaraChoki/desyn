import { canonicalEqual, type Id, newId, type Op, type Transaction } from "@desyn/schema";
import { afterEach, describe, expect, test, vi } from "vitest";
import { History, pruneOps } from "../src/store/history.ts";
import { createTestEditor, fixture, node } from "./editor-helpers.ts";
import { until } from "./fake-server.ts";

const upd = (id: Id, set: Record<string, unknown>): Op => ({ op: "update", id, set });
const remote = (ops: Op[]): Transaction => ({
  id: newId(),
  label: "Remote",
  ops,
  source: "user",
  ts: Date.now(),
});

afterEach(() => vi.restoreAllMocks());

describe("undo / redo", () => {
  test("undo restores the exact previous state and redo re-applies it (on the server too)", async () => {
    const f = fixture();
    const { editor, server } = await createTestEditor(f.design);
    const before = editor.design;
    await editor.apply([upd(f.a, { x: 300, name: "Moved" }), { op: "delete", id: f.b }], {
      label: "Edit",
    });
    const after = editor.design;
    expect(node(editor, f.a).x).toBe(300);
    expect(editor.getState().history.undoLabel).toBe("Edit");
    await editor.undo();
    expect(canonicalEqual(editor.design as never, before as never)).toBe(true);
    expect(editor.getState().history.redoLabel).toBe("Edit");
    await editor.redo();
    expect(canonicalEqual(editor.design as never, after as never)).toBe(true);
    await until(() => editor.sync.pending.length === 0);
    expect(canonicalEqual(server.design, editor.design as never)).toBe(true);
  });

  test("undo / redo cycles always reach the server (fresh transaction ids)", async () => {
    const f = fixture();
    const { editor, server } = await createTestEditor(f.design);
    await editor.apply([upd(f.a, { x: 1 })]);
    for (let i = 0; i < 3; i++) {
      await editor.undo();
      await editor.redo();
    }
    await until(() => editor.sync.pending.length === 0);
    expect(new Set(server.commitCalls).size).toBe(server.commitCalls.length);
    expect(server.seq).toBe(7);
    expect((server.design.nodes[f.a] as { x: number }).x).toBe(1);
  });

  test("steps with the same coalesce key merge within the window", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await editor.apply([upd(f.a, { x: 11 })], { coalesceKey: "nudge:a" });
    now += 300;
    await editor.apply([upd(f.a, { x: 12 })], { coalesceKey: "nudge:a" });
    now += 300;
    await editor.apply([upd(f.a, { x: 13 })], { coalesceKey: "nudge:a" });
    now += 5_000; // outside the window: a new step
    await editor.apply([upd(f.a, { x: 14 })], { coalesceKey: "nudge:a" });
    expect(editor.history.undoDepth).toBe(2);
    await editor.undo();
    expect(node(editor, f.a).x).toBe(13);
    await editor.undo();
    expect(node(editor, f.a).x).toBe(10);
  });

  test("consecutive transactions of one AI run are one undo step", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    const actor = { runId: "run1", agent: "desyn" };
    await editor.apply([upd(f.a, { x: 50 })], { source: "ai", actor, label: "AI: tidy" });
    await editor.apply([upd(f.b, { y: 7 })], { source: "ai", actor, label: "AI: tidy" });
    await editor.apply([upd(f.c, { opacity: 0.5 })], { source: "ai", actor, label: "AI: tidy" });
    expect(editor.history.undoDepth).toBe(1);
    await editor.undo();
    expect(node(editor, f.a).x).toBe(10);
    expect(node(editor, f.b).y).toBe(100);
    expect(node(editor, f.c).opacity).toBe(1);
  });

  test("the user's own server-run AI transactions are one undo step; others' runs are not undoable", async () => {
    const f = fixture();
    const { editor, server } = await createTestEditor(f.design);
    await editor.apply([upd(f.c, { name: "Mine" })], { label: "Rename C" });
    await until(() => editor.sync.pending.length === 0);
    // ai.runAgent commits through designs.commitAs as this user (actor.userId) with the run id.
    const aiTx = (ops: Op[], runId: string): Transaction => ({
      id: newId(),
      label: "AI: make it premium",
      ops,
      source: "ai",
      actor: { runId, agent: "desyn" },
      ts: Date.now(),
    });
    server.commit(aiTx([upd(f.a, { x: 70 })], "run1"), "user1");
    server.commit(aiTx([upd(f.b, { y: 5 }), upd(f.a, { width: 300 })], "run1"), "user1");
    // A collaborator's own run must not land in this user's history.
    server.commit(aiTx([upd(f.g, { opacity: 0.4 })], "run9"), "someone-else");
    server.notify();
    await until(() => node(editor, f.g).opacity === 0.4);
    expect(editor.history.undoDepth).toBe(2);
    expect(editor.getState().history.undoLabel).toBe("AI: make it premium");
    await editor.undo();
    expect(node(editor, f.a).x).toBe(10);
    expect(node(editor, f.a).width).toBe(100);
    expect(node(editor, f.b).y).toBe(100);
    expect(node(editor, f.g).opacity).toBe(0.4);
    expect(node(editor, f.c).name).toBe("Mine");
    await editor.redo();
    expect(node(editor, f.a).x).toBe(70);
    expect(node(editor, f.b).y).toBe(5);
    await until(() => editor.sync.pending.length === 0);
    expect((server.design.nodes[f.a] as { width: number }).width).toBe(300);
  });

  test("edits from the same user in another tab are treated like a collaborator's", async () => {
    const f = fixture();
    const { editor, server } = await createTestEditor(f.design);
    await editor.apply([upd(f.a, { x: 20 })], { label: "Move A" });
    await until(() => editor.sync.pending.length === 0);
    server.commit(remote([upd(f.a, { x: 500 })]), "user1");
    server.notify();
    await until(() => node(editor, f.a).x === 500);
    expect(editor.history.undoDepth).toBe(1);
    await editor.undo();
    expect(node(editor, f.a).x).toBe(500);
  });

  test("undo never reverts a collaborator's newer value, and skips steps fully overwritten", async () => {
    const f = fixture();
    const { editor, server } = await createTestEditor(f.design);
    await editor.apply([upd(f.a, { x: 20, y: 30 })], { label: "Move A" });
    await editor.apply([upd(f.b, { name: "Mine" })], { label: "Rename B" });
    await until(() => editor.sync.pending.length === 0);
    // Someone else changes A.x and renames B after us.
    server.commit(remote([upd(f.a, { x: 999 }), upd(f.b, { name: "Theirs" })]));
    server.notify();
    await until(() => node(editor, f.b).name === "Theirs");
    // "Rename B" was fully overwritten: undo skips it and undoes "Move A" (only its y).
    await editor.undo();
    expect(node(editor, f.b).name).toBe("Theirs");
    expect(node(editor, f.a).x).toBe(999);
    expect(node(editor, f.a).y).toBe(10);
    expect(editor.history.undoDepth).toBe(0);
  });

  test("undo restores the selection of the step", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.a]);
    await editor.apply([upd(f.b, { x: 1 })], { select: [f.b] });
    expect(editor.getState().selection).toEqual([f.b]);
    await editor.undo();
    expect(editor.getState().selection).toEqual([f.a]);
  });

  test("view-only editors cannot apply, undo or switch to drawing tools", async () => {
    const f = fixture();
    const { editor, notices } = await createTestEditor(f.design, { permission: "view" });
    expect(editor.getState().mode).toBe("view");
    expect(await editor.apply([upd(f.a, { x: 1 })])).toBeNull();
    expect(await editor.undo()).toBe(false);
    editor.setTool("rect");
    expect(editor.getState().tool).toBe("select");
    editor.setTool("hand");
    expect(editor.getState().tool).toBe("hand");
    expect(notices.some((n) => n.title.includes("view only"))).toBe(true);
  });
});

describe("History", () => {
  const entry = (id: string, ops: Op[], inverse: Op[], extra: object = {}) => ({
    id,
    label: id,
    forward: { id, label: id, ops, source: "user" as const, ts: 0 },
    inverse: { id: `${id}i`, label: id, ops: inverse, source: "user" as const, ts: 0 },
    ts: Date.now(),
    selectionBefore: [],
    selectionAfter: [],
    pageBefore: null,
    pageAfter: null,
    ...extra,
  });

  test("a new step clears redo; seal stops coalescing", () => {
    const h = new History();
    h.record(entry("a", [upd("n", { x: 1 })], [upd("n", { x: 0 })]), { coalesceKey: "k" });
    h.seal();
    h.record(entry("b", [upd("n", { x: 2 })], [upd("n", { x: 1 })]), { coalesceKey: "k" });
    expect(h.undoDepth).toBe(2);
    const e = h.takeUndo();
    if (e) h.pushRedo(e);
    expect(h.redoDepth).toBe(1);
    h.record(entry("c", [upd("n", { y: 1 })], [upd("n", { y: 0 })]));
    expect(h.redoDepth).toBe(0);
  });

  test("merged steps undo in reverse order", () => {
    const h = new History();
    h.record(entry("a", [upd("n", { x: 1 })], [upd("n", { x: 0 })]), { coalesceKey: "k" });
    h.record(
      entry(
        "b",
        [upd("n", { x: 2 }), upd("m", { y: 5 })],
        [upd("n", { x: 1 }), upd("m", { y: 0 })],
      ),
      {
        coalesceKey: "k",
      },
    );
    const merged = h.peekUndo();
    // Later step's inverse first, then the earlier one: n ends at 0.
    expect(merged?.inverse.ops).toEqual([
      { op: "update", id: "n", set: { x: 1 } },
      { op: "update", id: "m", set: { y: 0 } },
      { op: "update", id: "n", set: { x: 0 } },
    ]);
    expect(merged?.forward.ops.at(-1)).toEqual({ op: "update", id: "m", set: { y: 5 } });
  });

  test("pruneOps removes only what the remote footprint covers", () => {
    const touched = new Set([
      "n\u0000x",
      "n\u0000$position",
      "$styles\u0000colors",
      "$doc\u0000name",
    ]);
    expect(
      pruneOps(
        [
          { op: "update", id: "n", set: { x: 1, y: 2 }, unset: ["x"] },
          { op: "patch", id: "n", path: ["x"], value: 3 },
          { op: "patch", id: "n", path: ["layout", "gap"], value: 3 },
          { op: "move", id: "n", parent: "p", index: 0 },
          { op: "styles", path: ["colors", "c1"], value: null },
          { op: "doc", set: { name: "A", kind: "poster" } },
          { op: "delete", id: "z" },
        ],
        touched,
      ),
    ).toEqual([
      { op: "update", id: "n", set: { y: 2 } },
      { op: "patch", id: "n", path: ["layout", "gap"], value: 3 },
      { op: "doc", set: { kind: "poster" } },
      { op: "delete", id: "z" },
    ]);
  });
});
