import { canonicalEqual, type Id, newId, type Op, type Transaction } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import { createTestEditor, fixture, node } from "./editor-helpers.ts";
import { FakeEngine, fakeEngineFactory } from "./fake-engine.ts";
import { settle, until } from "./fake-server.ts";

const upd = (id: Id, set: Record<string, unknown>): Op => ({ op: "update", id, set });
const remote = (ops: Op[]): Transaction => ({
  id: newId(),
  label: "Remote",
  ops,
  source: "user",
  ts: Date.now(),
});

async function withEngine() {
  const f = fixture();
  const engine = new FakeEngine();
  const t = await createTestEditor(f.design, {
    engine: { createClient: fakeEngineFactory(engine) },
  });
  await t.editor.engine.attach(document.createElement("canvas"), () => t.editor.design);
  expect(t.editor.getState().engine.status).toBe("ready");
  return { ...t, f, engine };
}

describe("engine bridge", () => {
  test("the engine mirrors local edits and linear remote transactions", async () => {
    const { editor, server, engine, f } = await withEngine();
    await editor.apply([upd(f.a, { x: 42 })], { label: "Move" });
    expect((engine.design.nodes[f.a] as { x: number }).x).toBe(42);
    await until(() => editor.sync.pending.length === 0);
    server.commit(remote([upd(f.b, { name: "Theirs" })]));
    server.notify();
    await until(() => node(editor, f.b).name === "Theirs");
    await settle();
    expect(canonicalEqual(engine.design as never, editor.design as never)).toBe(true);
  });

  test("a remote change queued behind a local edit does not revert it in the engine", async () => {
    const { editor, server, transport, engine, f } = await withEngine();
    // No ack in this test (offline / slow server): only the bridge can keep the engine right.
    transport.hold = true;
    // The engine is busy normalizing a local edit while a collaborator's transaction arrives.
    const release = engine.gate();
    const local = editor.apply([upd(f.a, { x: 77 })], { label: "Move A" });
    await settle(2);
    server.commit(remote([upd(f.b, { y: 333 })]));
    server.notify();
    await until(() => node(editor, f.b).y === 333);
    release();
    await local;
    await settle();
    expect(node(editor, f.a).x).toBe(77);
    expect((engine.design.nodes[f.a] as { x: number }).x).toBe(77);
    expect((engine.design.nodes[f.b] as { y: number }).y).toBe(333);
    expect(canonicalEqual(engine.design as never, editor.design as never)).toBe(true);
  });

  test("an engine failure does not lose the edit; the engine catches up on the next change", async () => {
    const { editor, server, engine, f, telemetry } = await withEngine();
    engine.failNext = new Error("unreachable executed");
    await editor.apply([upd(f.a, { x: 64 })], { label: "Move" });
    expect(node(editor, f.a).x).toBe(64);
    await until(() => editor.sync.pending.length === 0);
    expect((server.design.nodes[f.a] as { x: number }).x).toBe(64);
    expect(telemetry.some((t) => t.event === "engine_apply_failed")).toBe(true);
    await settle();
    expect(canonicalEqual(engine.design as never, editor.design as never)).toBe(true);
  });

  test("a drag (preview per move, commit on release) is one transaction and one undo step", async () => {
    const { editor, server, engine, f } = await withEngine();
    const seqBefore = server.seq;
    for (const x of [12, 30, 55, 80]) {
      await editor.preview({
        id: newId(),
        label: "Move",
        ops: [upd(f.a, { x })],
        source: "user",
        ts: Date.now(),
      });
    }
    // Nothing is committed while dragging.
    expect(node(editor, f.a).x).toBe(10);
    expect(editor.sync.pending).toHaveLength(0);
    await editor.commitPreview({ label: "Move" });
    expect(node(editor, f.a).x).toBe(80);
    expect(editor.history.undoDepth).toBe(1);
    await until(() => editor.sync.pending.length === 0);
    expect(server.seq).toBe(seqBefore + 1);
    await editor.undo();
    expect(node(editor, f.a).x).toBe(10);
    await settle();
    expect((engine.design.nodes[f.a] as { x: number }).x).toBe(10);
  });

  test("a rejected transaction is rolled back in the engine too", async () => {
    const { editor, transport, engine, f } = await withEngine();
    transport.failNext({ data: { code: "FORBIDDEN", message: "No." } });
    await editor.apply([upd(f.c, { name: "Nope" })], { label: "Rename" });
    await until(() => editor.sync.pending.length === 0);
    await settle();
    expect(node(editor, f.c).name).toBe("C");
    expect((engine.design.nodes[f.c] as { name: string }).name).toBe("C");
  });
});
