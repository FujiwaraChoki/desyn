import { approxBounds, pages } from "@desyn/doc-ops";
import type { Id, Node } from "@desyn/schema";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildPasteOps,
  encodeHtml,
  payloadFromHtml,
  serializeNodes,
  svgSize,
} from "../src/commands/clipboard.ts";
import { CommandRegistry } from "../src/commands/registry.ts";
import { evaluateWhen, validateWhen } from "../src/commands/when.ts";
import type { EditorController } from "../src/controller.ts";
import { DEFAULT_KEYMAP } from "../src/shortcuts/defaults.ts";
import { installShortcuts } from "../src/shortcuts/dispatcher.ts";
import {
  comboFromEvent,
  effectiveKeymap,
  findConflicts,
  matchKey,
  normalizeCombo,
} from "../src/shortcuts/keymap.ts";
import { KEY_COMBO, sanitizeKeymap } from "../src/store/prefs.ts";
import { createTestEditor, fixture, node, pageIdOf } from "./editor-helpers.ts";
import { settle, until } from "./fake-server.ts";

const run = (editor: EditorController, id: string, args?: unknown) =>
  editor.commands.run(id, args, "palette");

describe("when-clauses", () => {
  const ctx = { a: true, b: false, n: 3, s: "select", none: null };
  test.each([
    ["a", true],
    ["!a", false],
    ["a && b", false],
    ["a || b", true],
    ["!(a && b)", true],
    ["n > 2 && n <= 3", true],
    ["n >= 4", false],
    ["s == 'select'", true],
    ['s != "hand"', true],
    ["missing", false],
    ["!missing && a", true],
    ["a && (b || n == 3)", true],
  ])("%s -> %s", (expr, expected) => {
    expect(evaluateWhen(expr, ctx)).toBe(expected);
  });

  test("syntax errors are reported at registration", () => {
    expect(() => validateWhen("a &&")).toThrow();
    expect(() => validateWhen("(a")).toThrow();
    expect(() => validateWhen("a ? b")).toThrow();
    const registry = new CommandRegistry(() => ({}) as EditorController);
    expect(() =>
      registry.register({ id: "x.y", label: "X", category: "edit", when: "a &&", run: () => {} }),
    ).toThrow();
  });

  test("duplicate command ids are refused; unregister restores", () => {
    const registry = new CommandRegistry(
      () => ({ context: () => ({}) }) as unknown as EditorController,
    );
    const off = registry.register({ id: "x.y", label: "X", category: "edit", run: () => {} });
    expect(() =>
      registry.register({ id: "x.y", label: "Y", category: "edit", run: () => {} }),
    ).toThrow();
    off();
    expect(registry.get("x.y")).toBeUndefined();
  });
});

describe("editor commands", () => {
  test("duplicate selects the offset copy; delete removes it", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.a]);
    await run(editor, "edit.duplicate");
    const [copy] = editor.getState().selection;
    expect(copy).toBeDefined();
    expect(copy).not.toBe(f.a);
    expect(node(editor, copy as Id).x).toBe(26);
    await run(editor, "edit.delete");
    expect(editor.design?.nodes[copy as Id]).toBeUndefined();
    expect(editor.getState().selection).toEqual([]);
  });

  test("group, then ungroup selects the children again", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.a, f.b]);
    await run(editor, "edit.group");
    const [group] = editor.getState().selection;
    expect(node(editor, group as Id).type).toBe("group");
    expect(node(editor, f.a).parent).toBe(group);
    await run(editor, "edit.ungroup");
    expect(editor.design?.nodes[group as Id]).toBeUndefined();
    expect(new Set(editor.getState().selection)).toEqual(new Set([f.a, f.b]));
    expect(node(editor, f.a).x).toBe(10);
  });

  test("align, distribute, z-order and auto layout", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.a, f.b, f.c]);
    await run(editor, "arrange.alignLeft");
    expect([f.a, f.b, f.c].map((id) => node(editor, id).x)).toEqual([10, 10, 10]);
    await run(editor, "arrange.alignTop");
    expect(node(editor, f.c).y).toBe(10);
    editor.select([f.a]);
    await run(editor, "arrange.bringToFront");
    const page = editor.currentPage();
    expect(page?.children.at(-1)).toBe(f.a);
    await run(editor, "arrange.sendToBack");
    expect(editor.currentPage()?.children[0]).toBe(f.a);
    editor.select([f.b, f.c]);
    await run(editor, "edit.autoLayout");
    const [frame] = editor.getState().selection;
    const fr = node(editor, frame as Id) as Node & { layout?: { mode: string } };
    expect(fr.type).toBe("frame");
    expect(fr.layout?.mode).toBeDefined();
  });

  test("holding an arrow key nudges in one undo step", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.a]);
    for (let i = 0; i < 5; i++) await run(editor, "edit.nudgeRight");
    await run(editor, "edit.nudgeDownBig");
    expect(node(editor, f.a).x).toBe(15);
    expect(node(editor, f.a).y).toBe(20);
    expect(editor.history.undoDepth).toBe(1);
    await editor.undo();
    expect(node(editor, f.a).x).toBe(10);
    expect(node(editor, f.a).y).toBe(10);
  });

  test("lock, hide and flip toggle the whole selection", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.a, f.b]);
    await run(editor, "edit.toggleLock");
    expect(node(editor, f.a).locked && node(editor, f.b).locked).toBe(true);
    expect(editor.commands.label("edit.toggleLock")).toBe("Unlock");
    await run(editor, "edit.toggleLock");
    expect(node(editor, f.a).locked).toBe(false);
    await run(editor, "edit.toggleVisibility");
    expect(node(editor, f.b).visible).toBe(false);
    await run(editor, "edit.flipHorizontal");
    expect(node(editor, f.a).flipX).toBe(true);
  });

  test("pages: add after the current one, navigate, move and delete", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    expect(editor.commands.isEnabled("page.delete")).toBe(false);
    await run(editor, "page.add");
    const ids = pages(editor.design as never).map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(editor.getState().pageId).toBe(ids[1]);
    await run(editor, "page.previous");
    expect(editor.getState().pageId).toBe(f.page);
    await run(editor, "page.moveDown");
    expect(pages(editor.design as never).map((p) => p.id)).toEqual([ids[1], f.page]);
    await run(editor, "page.delete");
    expect(pages(editor.design as never).map((p) => p.id)).toEqual([ids[1]]);
    expect(editor.getState().pageId).toBe(ids[1]);
  });

  test("selection navigation: all, enter, parent, escape", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    await run(editor, "selection.selectAll");
    expect(new Set(editor.getState().selection)).toEqual(new Set([f.a, f.b, f.c, f.g]));
    editor.select([f.g]);
    await run(editor, "selection.enter");
    expect(new Set(editor.getState().selection)).toEqual(new Set([f.g1, f.g2]));
    expect(editor.getState().scopeId).toBe(f.g);
    await run(editor, "selection.clear");
    expect(editor.getState().selection).toEqual([f.g]);
    await run(editor, "selection.clear");
    expect(editor.getState().selection).toEqual([]);
    editor.select([f.g1]);
    await run(editor, "selection.parent");
    expect(editor.getState().selection).toEqual([f.g]);
  });

  test("renaming the design commits a doc op", async () => {
    const f = fixture();
    const { editor, server } = await createTestEditor(f.design);
    await editor.apply([{ op: "doc", set: { name: "Launch poster" } }], { label: "Rename design" });
    await until(() => server.design.name === "Launch poster");
    expect(editor.getState().doc.design?.name).toBe("Launch poster");
  });

  test("present navigates to the presenter at the current page", async () => {
    const f = fixture();
    const { editor, navigated } = await createTestEditor(f.design);
    await run(editor, "file.present");
    expect(navigated).toEqual(["/present/d1?slide=1"]);
    await run(editor, "file.exit");
    expect(navigated.at(-1)).toBe("/");
  });

  test("commands of missing extensions are disabled (export / share modals)", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    expect(editor.commands.isEnabled("file.export")).toBe(false);
    expect(editor.commands.isEnabled("panel.toggleAiDock")).toBe(false);
    editor.extensions.addModal({ id: "export", component: () => null });
    expect(editor.commands.isEnabled("file.export")).toBe(true);
    await run(editor, "file.export");
    expect(editor.getState().modal?.id).toBe("export");
  });
});

describe("clipboard", () => {
  test("payloads round-trip through HTML", () => {
    const f = fixture();
    const payload = serializeNodes(f.design, [f.a, f.g]);
    expect(payload?.nodes.map((n) => n.id)).toEqual([f.a, f.g, f.g1, f.g2]);
    const html = encodeHtml(payload as never);
    expect(payloadFromHtml(html)).toEqual(payload);
    expect(payloadFromHtml("<p>hello</p>")).toBeNull();
  });

  test("pasting keeps world placement of nested rotated layers, with fresh ids", () => {
    const f = fixture();
    const payload = serializeNodes(f.design, [f.g1]);
    if (!payload) throw new Error("no payload");
    const { ops, roots } = buildPasteOps(f.design, payload, f.page, { x: 0, y: 0 });
    expect(roots[0]).not.toBe(f.g1);
    const created = ops.find((o) => o.op === "create");
    const head = created && created.op === "create" ? created.nodes[0] : undefined;
    expect(head?.parent).toBe(f.page);
    expect(head?.rotation).toBeCloseTo(30, 4);
    const before = approxBounds(f.design, f.g1);
    const after = approxBounds(
      { ...f.design, nodes: { ...f.design.nodes, [(head as Node).id]: head as Node } },
      (head as Node).id,
    );
    expect(after?.x).toBeCloseTo(before?.x ?? 0, 3);
    expect(after?.y).toBeCloseTo(before?.y ?? 0, 3);
  });

  test("asset refs from a pasted payload never carry a url (clipboard content is untrusted)", () => {
    const f = fixture();
    const payload = serializeNodes(f.design, [f.a]);
    if (!payload) throw new Error("no payload");
    payload.assets = [
      {
        id: "img000000001",
        kind: "image",
        mime: "image/png",
        url: "https://tracker.example/p.png",
      },
    ];
    const { ops } = buildPasteOps(f.design, payload, f.page, { x: 0, y: 0 });
    const asset = ops.find((o) => o.op === "asset");
    expect(asset && asset.op === "asset" ? asset.set?.img000000001 : undefined).toEqual({
      id: "img000000001",
      kind: "image",
      mime: "image/png",
    });
  });

  test("copy / paste through DOM clipboard events, cascading offsets", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.a]);
    const data = new Map<string, string>();
    const copyEvent = {
      clipboardData: {
        setData: (t: string, v: string) => data.set(t, v),
        getData: (t: string) => data.get(t) ?? "",
      },
      preventDefault() {},
    } as unknown as ClipboardEvent;
    expect(editor.clipboard.handleCopyEvent(copyEvent, false)).toBe(true);
    expect([...data.keys()].sort()).toEqual([
      "application/x-desyn+json",
      "text/html",
      "text/plain",
    ]);
    const pasteEvent = {
      clipboardData: { getData: (t: string) => data.get(t) ?? "", files: [] },
      preventDefault() {},
    } as unknown as ClipboardEvent;
    editor.clearSelection();
    expect(editor.clipboard.handlePasteEvent(pasteEvent)).toBe(true);
    await until(() => editor.getState().selection.length === 1);
    const first = editor.getState().selection[0] as Id;
    expect(first).not.toBe(f.a);
    expect(node(editor, first).x).toBe(26);
    editor.clearSelection();
    editor.clipboard.handlePasteEvent(pasteEvent);
    await until(
      () =>
        editor.getState().selection[0] !== undefined && editor.getState().selection[0] !== first,
    );
    expect(node(editor, editor.getState().selection[0] as Id).x).toBe(42);
  });

  test("paste in place keeps the exact position; cut deletes", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.b]);
    const data = new Map<string, string>();
    const ev = (extra: object) =>
      ({
        clipboardData: {
          setData: (t: string, v: string) => data.set(t, v),
          getData: (t: string) => data.get(t) ?? "",
          files: [],
        },
        preventDefault() {},
        ...extra,
      }) as unknown as ClipboardEvent;
    editor.clipboard.handleCopyEvent(ev({}), true);
    await until(() => !editor.design?.nodes[f.b]);
    editor.clipboard.armPasteInPlace();
    editor.clipboard.handlePasteEvent(ev({}));
    await until(() => editor.getState().selection.length === 1);
    const pasted = node(editor, editor.getState().selection[0] as Id);
    expect([pasted.x, pasted.y]).toEqual([200, 100]);
  });

  test("text and SVG from other apps become layers", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    await editor.clipboard.insertPlainText("Hello sun");
    const text = node(editor, editor.getState().selection[0] as Id) as Node & {
      runs: { text: string }[];
    };
    expect(text.type).toBe("text");
    expect(text.runs[0]?.text).toBe("Hello sun");
    await editor.clipboard.insertPlainText(
      '<svg viewBox="0 0 24 12" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v12z"/></svg>',
    );
    const svg = node(editor, editor.getState().selection[0] as Id) as Node & { markup?: string };
    expect(svg.type).toBe("svg");
    expect(svg.width / svg.height).toBeCloseTo(2, 5);
    expect(svgSize('<svg width="300px" height="100">')).toEqual({ width: 300, height: 100 });
  });

  test("image uploads report a clear error when storage is not configured", async () => {
    const f = fixture();
    const { editor, notices } = await createTestEditor(f.design);
    await editor.clipboard.insertFiles([
      new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }),
    ]);
    expect(notices.at(-1)?.title).toBe('Couldn\'t upload "a.png"');
    expect(notices.at(-1)?.description).toContain("not configured");
  });

  test("pasting into a selected frame converts to its coordinates", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    editor.select([f.b, f.c]);
    await run(editor, "edit.frameSelection");
    const [frame] = editor.getState().selection;
    const payload = serializeNodes(editor.design as never, [f.a]);
    editor.select([frame as Id]);
    const roots = await editor.clipboard.insertPayload(payload as never, true);
    const pasted = node(editor, roots[0] as Id);
    expect(pasted.parent).toBe(frame);
    const fr = node(editor, frame as Id);
    expect(pasted.x + fr.x).toBe(10);
  });
});

describe("shortcuts", () => {
  const key = (k: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
    ({
      key: k,
      code,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...mods,
    }) as KeyboardEvent;

  test("matching handles shifted digits, punctuation and per-OS mod", () => {
    expect(matchKey(key(")", "Digit0", { shiftKey: true }), "shift+0", "linux")).toBe(true);
    expect(matchKey(key("!", "Digit1", { shiftKey: true }), "shift+1", "mac")).toBe(true);
    expect(
      matchKey(key('"', "Quote", { shiftKey: true, ctrlKey: true }), "mod+shift+'", "linux"),
    ).toBe(true);
    expect(matchKey(key("'", "Quote", { ctrlKey: true }), "mod+'", "linux")).toBe(true);
    expect(matchKey(key("d", "KeyD", { metaKey: true }), "mod+d", "mac")).toBe(true);
    expect(matchKey(key("d", "KeyD", { metaKey: true }), "mod+d", "linux")).toBe(false);
    expect(matchKey(key("+", "Equal", { shiftKey: true }), "plus", "linux")).toBe(true);
    expect(matchKey(key("D", "KeyD", { shiftKey: true }), "d", "linux")).toBe(false);
  });

  test("stored keymaps keep only combos the profile accepts", () => {
    expect(
      sanitizeKeymap({
        "view.toggleFocusMode": ["mod+\\", "<script>", "mod+ k", "ö", 5],
        "edit.duplicate": ["mod+shift+d", "alt+<", "pageup", "f12"],
        "bad id!": ["v"],
      }),
    ).toEqual({
      "view.toggleFocusMode": ["mod+\\"],
      "edit.duplicate": ["mod+shift+d", "alt+<", "pageup", "f12"],
    });
    for (const id of Object.keys(DEFAULT_KEYMAP)) {
      for (const combo of DEFAULT_KEYMAP[id] ?? []) expect(KEY_COMBO.test(combo), combo).toBe(true);
    }
  });

  test("recorded combos, normalization and conflicts", () => {
    expect(comboFromEvent(key("K", "KeyK", { ctrlKey: true, shiftKey: true }), "linux")).toBe(
      "mod+shift+k",
    );
    expect(comboFromEvent(key("k", "KeyK", { metaKey: true }), "mac")).toBe("mod+k");
    expect(comboFromEvent(key("Shift", "ShiftLeft", { shiftKey: true }), "mac")).toBeNull();
    expect(normalizeCombo("shift+mod+K")).toBe("mod+shift+k");
    const conflicts = findConflicts(
      new Map([
        ["a", ["mod+d"]],
        ["b", ["shift+mod+D"]],
        ["c", ["v"]],
      ]),
    );
    expect(conflicts.get("mod+shift+d")).toBeUndefined();
    expect(
      findConflicts(
        new Map([
          ["a", ["mod+d"]],
          ["b", ["mod+d"]],
        ]),
      ).get("mod+d"),
    ).toEqual(["a", "b"]);
  });

  test("overrides replace defaults (an empty list unbinds)", async () => {
    const f = fixture();
    const { editor } = await createTestEditor(f.design);
    const map = effectiveKeymap(editor.commands, {
      "edit.duplicate": ["mod+shift+d"],
      "tool.pen": [],
    });
    expect(map.get("edit.duplicate")).toEqual(["mod+shift+d"]);
    expect(map.has("tool.pen")).toBe(false);
    expect(map.get("history.undo")).toEqual(["mod+z"]);
  });

  describe("dispatcher", () => {
    let uninstall: (() => void) | null = null;
    afterEach(() => uninstall?.());

    const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e;
    };

    test("runs enabled commands, respects inputs, buttons, repeat and space-hold", async () => {
      const f = fixture();
      const { editor } = await createTestEditor(f.design);
      uninstall = installShortcuts(editor, window, "linux");
      editor.select([f.a]);
      const e = press({ key: "d", code: "KeyD", ctrlKey: true });
      expect(e.defaultPrevented).toBe(true);
      await until(() => editor.getState().selection[0] !== f.a);

      const input = document.createElement("input");
      document.body.appendChild(input);
      press({ key: "r", code: "KeyR" }, input);
      expect(editor.getState().tool).toBe("select");
      press({ key: "r", code: "KeyR" });
      expect(editor.getState().tool).toBe("rect");

      const button = document.createElement("button");
      document.body.appendChild(button);
      const tab = press({ key: "Tab", code: "Tab" }, button);
      expect(tab.defaultPrevented).toBe(false);

      const before = editor.history.undoDepth;
      press({ key: "d", code: "KeyD", ctrlKey: true, repeat: true });
      await settle();
      expect(editor.history.undoDepth).toBe(before);

      press({ key: " ", code: "Space" });
      expect(editor.getState().heldTool).toBe("hand");
      window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space" }));
      expect(editor.getState().heldTool).toBeNull();
      input.remove();
      button.remove();
    });

    test("Tab cycles layers only with a selection; otherwise focus moves on", async () => {
      const f = fixture();
      const { editor } = await createTestEditor(f.design);
      uninstall = installShortcuts(editor, window, "linux");
      const free = press({ key: "Tab", code: "Tab" });
      expect(free.defaultPrevented).toBe(false);
      expect(editor.getState().selection).toEqual([]);
      editor.select([f.a]);
      const cycle = press({ key: "Tab", code: "Tab" });
      expect(cycle.defaultPrevented).toBe(true);
      await until(() => editor.getState().selection[0] === f.b);
    });

    test("a failing command reports an error instead of rejecting", async () => {
      const f = fixture();
      const { editor, notices, telemetry } = await createTestEditor(f.design);
      editor.commands.register({
        id: "test.boom",
        label: "Boom",
        category: "help",
        run: () => {
          throw new Error("kaput");
        },
      });
      await expect(editor.commands.run("test.boom")).resolves.toBe(false);
      expect(notices.at(-1)).toMatchObject({
        kind: "error",
        title: "Boom failed",
        description: "kaput",
      });
      expect(telemetry.find((t) => t.event === "command_failed")?.props).toMatchObject({
        command: "test.boom",
      });
    });

    test("copy shortcuts pass through to the native clipboard event", async () => {
      const f = fixture();
      const { editor } = await createTestEditor(f.design);
      uninstall = installShortcuts(editor, window, "linux");
      editor.select([f.a]);
      const e = press({ key: "c", code: "KeyC", ctrlKey: true });
      expect(e.defaultPrevented).toBe(false);
      const undo = press({ key: "z", code: "KeyZ", ctrlKey: true });
      expect(undo.defaultPrevented).toBe(false); // nothing to undo: not handled
    });
  });
});

test("fixture sanity", () => {
  const f = fixture();
  expect(pageIdOf(f.design)).toBe(f.page);
});
