import { describe, expect, test } from "vitest";
import type { PresenceRow } from "../../src/collab/backend.ts";
import {
  cursorsOnPage,
  editingMarkers,
  followRect,
  peopleOf,
  reducePresence,
  sameRect,
  selectionsOnPage,
  toScreen,
} from "../../src/collab/presence/reduce.ts";
import { fixture } from "./fixtures.ts";

const NOW = 1_000_000;

function row(over: Partial<PresenceRow> & Pick<PresenceRow, "sessionId" | "userId">): PresenceRow {
  return {
    name: "Someone",
    image: null,
    color: "#ff6b6b",
    cursor: null,
    selection: [],
    viewport: null,
    drag: null,
    editing: null,
    expiresAt: NOW + 10_000,
    updatedAt: NOW - 1_000,
    ...over,
  };
}

describe("presence reduction", () => {
  test("drops the own session and expired rows, keeps the newest row per session", () => {
    const rows = [
      row({ sessionId: "mine0000", userId: "u1", name: "Me" }),
      row({ sessionId: "s-ada000", userId: "u2", name: "Ada", updatedAt: NOW - 5_000 }),
      row({
        sessionId: "s-ada000",
        userId: "u2",
        name: "Ada",
        updatedAt: NOW - 100,
        color: "#4dabf7",
      }),
      row({ sessionId: "s-old000", userId: "u3", name: "Gone", expiresAt: NOW - 1 }),
    ];
    const out = reducePresence(rows, { sessionId: "mine0000", userId: "u1", now: NOW });
    expect(out.map((c) => c.sessionId)).toEqual(["s-ada000"]);
    expect(out[0]?.color).toBe("#4dabf7");
  });

  test("marks the user's other tabs, guests, and sorts people before own tabs", () => {
    const rows = [
      row({ sessionId: "tab20000", userId: "u1", name: "Me" }),
      row({ sessionId: "zed00000", userId: "u9", name: "Zed" }),
      row({ sessionId: "guest000", userId: "guest:guest000", name: "" }),
      row({ sessionId: "amy00000", userId: "u4", name: "Amy" }),
    ];
    const out = reducePresence(rows, { sessionId: "mine0000", userId: "u1", now: NOW });
    expect(out.map((c) => c.name)).toEqual(["Amy", "Guest", "Zed", "Me"]);
    expect(out.find((c) => c.name === "Me")?.isSelf).toBe(true);
    expect(out.find((c) => c.name === "Guest")?.guest).toBe(true);
    // The avatar stack never shows the own user; one entry per person with the latest session.
    const people = peopleOf(
      reducePresence(
        [
          ...rows,
          row({
            sessionId: "amy11111",
            userId: "u4",
            name: "Amy",
            updatedAt: NOW,
            color: "#20c997",
          }),
        ],
        { sessionId: "mine0000", userId: "u1", now: NOW },
      ),
    );
    expect(people.map((p) => p.name)).toEqual(["Amy", "Guest", "Zed"]);
    const amy = people[0];
    expect(amy?.sessions).toHaveLength(2);
    expect(amy?.primary.sessionId).toBe("amy11111");
    expect(amy?.color).toBe("#20c997");
  });

  test("cursors only on the current page, finite coordinates only", () => {
    const list = reducePresence(
      [
        row({ sessionId: "a0000000", userId: "a", cursor: { x: 10, y: 20, pageId: "p1" } }),
        row({ sessionId: "b0000000", userId: "b", cursor: { x: 1, y: 2, pageId: "p2" } }),
        row({ sessionId: "c0000000", userId: "c", cursor: { x: Number.NaN, y: 2, pageId: "p1" } }),
        row({ sessionId: "d0000000", userId: "d", cursor: null }),
      ],
      { sessionId: "me000000", userId: null, now: NOW },
    );
    expect(cursorsOnPage(list, "p1").map((c) => [c.sessionId, c.x, c.y])).toEqual([
      ["a0000000", 10, 20],
    ]);
    expect(cursorsOnPage(list, null)).toEqual([]);
  });

  test("selections become page-space boxes of nodes on the current page", () => {
    const f = fixture();
    const list = reducePresence(
      [
        row({
          sessionId: "a0000000",
          userId: "a",
          name: "Ada",
          selection: [f.a, f.b, "missing", f.page],
        }),
        row({ sessionId: "b0000000", userId: "b", selection: [] }),
      ],
      { sessionId: "me000000", userId: null, now: NOW },
    );
    const sel = selectionsOnPage(list, f.design, f.page);
    expect(sel).toHaveLength(1);
    expect(sel[0]?.rects.map((r) => r.id)).toEqual([f.a, f.b]);
    expect(sel[0]?.bounds).toEqual({ x: 10, y: 10, width: 270, height: 170 });
    expect(selectionsOnPage(list, f.design, "otherpage000")).toEqual([]);
    // A child of a rotated group is found on its page too.
    const g = selectionsOnPage(
      reducePresence([row({ sessionId: "c0000000", userId: "c", selection: [f.g1] })], {
        sessionId: "me000000",
        userId: null,
        now: NOW,
      }),
      f.design,
      f.page,
    );
    expect(g[0]?.rects[0]?.id).toBe(f.g1);
  });

  test("editing markers label typing and AI work, first session wins per layer", () => {
    const list = reducePresence(
      [
        row({
          sessionId: "a0000000",
          userId: "a",
          name: "Ada",
          editing: { nodeIds: ["n1"], kind: "text" },
        }),
        row({
          sessionId: "b0000000",
          userId: "b",
          name: "Bo",
          editing: { nodeIds: ["n1", "n2"], kind: "ai", label: "AI: restyling" },
        }),
      ],
      { sessionId: "me000000", userId: null, now: NOW },
    );
    const m = editingMarkers(list);
    expect(m.get("n1")?.label).toBe("Ada is typing");
    expect(m.get("n2")?.label).toBe("AI: restyling");
  });

  test("follow mode fits the area the other person sees", () => {
    expect(followRect({ x: 100, y: 50, zoom: 2, width: 800, height: 600, pageId: "p1" })).toEqual({
      pageId: "p1",
      rect: { x: 100, y: 50, w: 400, h: 300 },
    });
    expect(followRect({ x: 0, y: 0, zoom: 0, width: 800, height: 600 })).toBeNull();
    expect(followRect({ x: 0, y: 0, zoom: 1 })).toBeNull();
    expect(followRect(null)).toBeNull();
    expect(sameRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 0.2, y: 0, w: 10, h: 10 }, 1)).toBe(true);
    expect(sameRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 0.2, y: 0, w: 10, h: 10 }, 4)).toBe(false);
    expect(toScreen({ x: 100, y: 50, zoom: 2 }, { x: 110, y: 60 })).toEqual({ x: 20, y: 20 });
  });
});
