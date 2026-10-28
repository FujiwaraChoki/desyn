import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { createUser, errorData, setupTest } from "./harness.helpers";

describe("editor/prefs", () => {
  test("signed-out users get null and cannot save", async () => {
    const t = setupTest();
    expect(await t.query(api.editor.prefs.get, {})).toBeNull();
    expect((await errorData(t.mutation(api.editor.prefs.set, { ui: "{}" }))).code).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("saves, merges fields and keeps users apart", async () => {
    const t = setupTest();
    const a = await createUser(t);
    const b = await createUser(t);
    expect(await a.as.query(api.editor.prefs.get, {})).toBeNull();
    await a.as.mutation(api.editor.prefs.set, {
      ui: JSON.stringify({ left: "layers", leftWidth: 300 }),
    });
    await a.as.mutation(api.editor.prefs.set, {
      shortcuts: JSON.stringify({ "edit.duplicate": ["mod+shift+d"], "tool.pen": [] }),
    });
    const got = await a.as.query(api.editor.prefs.get, {});
    expect(got && JSON.parse(got.ui ?? "{}")).toEqual({ left: "layers", leftWidth: 300 });
    expect(got && JSON.parse(got.shortcuts ?? "{}")).toEqual({
      "edit.duplicate": ["mod+shift+d"],
      "tool.pen": [],
    });
    expect(await b.as.query(api.editor.prefs.get, {})).toBeNull();
  });

  test("accepts every combo the editor records (punctuation and named keys)", async () => {
    const t = setupTest();
    const a = await createUser(t);
    const shortcuts = JSON.stringify({
      "view.toggleFocusMode": ["mod+\\", "mod+shift+'"],
      "edit.duplicate": ["alt+<", "mod+alt+]"],
      "page.next": ["pagedown", "f12"],
      "view.zoomIn": ["plus", "mod+="],
    });
    await a.as.mutation(api.editor.prefs.set, { shortcuts });
    const got = await a.as.query(api.editor.prefs.get, {});
    expect(got?.shortcuts).toBe(shortcuts);
  });

  test("rejects malformed or oversized values", async () => {
    const t = setupTest();
    const a = await createUser(t);
    const bad = [
      { ui: "not json" },
      { ui: "[1,2]" },
      { ui: JSON.stringify({ x: "a".repeat(20_000) }) },
      { shortcuts: JSON.stringify({ "edit.copy": "mod+c" }) },
      { shortcuts: JSON.stringify({ "edit.copy": ["<script>"] }) },
      { shortcuts: JSON.stringify({ "edit.copy": ["mod+ k"] }) },
      { shortcuts: JSON.stringify({ "bad id!": ["v"] }) },
    ];
    for (const args of bad) {
      expect((await errorData(a.as.mutation(api.editor.prefs.set, args))).code).toBe(
        "INVALID_ARGUMENT",
      );
    }
  });

  test("account cleanup removes the row", async () => {
    const t = setupTest();
    const a = await createUser(t);
    await a.as.mutation(api.editor.prefs.set, { ui: "{}" });
    expect(await t.mutation(internal.editor.prefs.userCleanup, { userId: a.userId })).toEqual({
      done: false,
    });
    expect(await t.mutation(internal.editor.prefs.userCleanup, { userId: a.userId })).toEqual({
      done: true,
    });
    expect(await a.as.query(api.editor.prefs.get, {})).toBeNull();
  });
});
