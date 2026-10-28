import {
  createChart,
  createTable,
  createText,
  defaultParagraph,
  defaultTextStyle,
} from "@desyn/schema";
import { describe, expect, test } from "vitest";
import {
  coalesceOps,
  parsePath,
  reorderMoves,
  scaledProps,
  scalePath,
  serializePath,
} from "../src";

describe("svg path data", () => {
  test("parses every command with implicit repeats", () => {
    const cmds = parsePath(
      "M10,20 30 40 l5-5 H100 v.5 C1 2 3 4 5 6 S1 2 3 4 Q1 2 3 4 T5 6 A10 20 30 1 0 40 50 z m1 1",
    );
    expect(cmds.map((c) => c.cmd).join("")).toBe("MLlHvCSQTAzm");
    expect(cmds[1]?.args).toEqual([30, 40]);
    expect(cmds[2]?.args).toEqual([5, -5]);
    expect(cmds[4]?.args).toEqual([0.5]);
    expect(cmds[9]?.args).toEqual([10, 20, 30, 1, 0, 40, 50]);
    expect(parsePath("M0 0a1 1 0 1110 10")[1]?.args).toEqual([1, 1, 0, 1, 1, 10, 10]);
    expect(parsePath("m1e2-1E-1")[0]?.args).toEqual([100, -0.1]);
  });

  test("rejects malformed data", () => {
    expect(() => parsePath("10 10")).toThrow();
    expect(() => parsePath("M0 0 B1 1")).toThrow();
    expect(() => parsePath("M0")).toThrow();
    expect(() => parsePath("M0 0 A1 1 0 2 0 1 1")).toThrow();
  });

  test("scales coordinates, radii and flips sweep when mirrored", () => {
    expect(scalePath("M0 0L100 50H10V20Z", 2, 0.5)).toBe("M0 0L200 25H20V10Z");
    expect(scalePath("M0 0A10 20 0 0 1 30 40", 2, 3)).toBe("M0 0A20 60 0 0 1 60 120");
    expect(scalePath("M0 0A10 10 0 0 1 30 40", -1, 1)).toBe("M0 0A10 10 0 0 0 -30 40");
    expect(serializePath(parsePath("M0.33333 0.66666z"))).toBe("M0.333 0.667z");
  });
});

describe("scaledProps", () => {
  test("text, table and chart sizes", () => {
    const text = createText({
      id: "texttexttext",
      style: defaultTextStyle({ fontSize: 40 }),
      runs: [{ text: "a", style: { fontSize: 20 } }, { text: "b" }],
      paragraph: defaultParagraph({
        lineHeight: { unit: "px", value: 50 },
        spacing: 10,
        indent: 4,
      }),
      strokes: [{ fills: [], width: 2, align: "center", cap: "butt", join: "miter", dash: [4, 2] }],
      effects: [
        { type: "dropShadow", x: 2, y: 4, blur: 8, spread: 0, color: "#000000" },
        { type: "noise", amount: 1, scale: 1, mono: true },
      ],
    });
    const s = scaledProps(text, 0.5, 0.5, 0.5);
    expect(s).toMatchObject({ width: 160, x: 0, y: 0 });
    expect((s.style as { fontSize: number }).fontSize).toBe(20);
    expect((s.runs as { style?: { fontSize: number } }[])[0]?.style?.fontSize).toBe(10);
    expect(
      (s.paragraph as { lineHeight: { value: number }; spacing: number }).lineHeight.value,
    ).toBe(25);
    expect((s.strokes as { width: number; dash: number[] }[])[0]).toMatchObject({
      width: 1,
      dash: [2, 1],
    });
    expect((s.effects as { blur?: number }[])[0]?.blur).toBe(4);
    const table = scaledProps(createTable({ id: "tabletablet", rows: 1, cols: 2 }), 2, 1, 1);
    expect(table.colWidths).toEqual([240, 240]);
    expect(table.rowHeights).toEqual([40]);
    const chart = scaledProps(createChart({ id: "chartchartch" }), 2, 2, 2);
    expect((chart.options as { fontSize: number }).fontSize).toBe(28);
    expect(scaledProps(createText({ id: "texttexttext" }), 1, 1, 1, false).x).toBeUndefined();
  });
});

describe("reorderMoves", () => {
  function applyMoves(list: string[], moves: { id: string; index?: number }[]) {
    const out = list.slice();
    for (const m of moves) {
      out.splice(out.indexOf(m.id), 1);
      out.splice(m.index as number, 0, m.id);
    }
    return out;
  }

  test("produces the target with the fewest moves", () => {
    const cur = ["a", "b", "c", "d", "e"];
    for (const target of [
      ["b", "c", "d", "e", "a"],
      ["e", "a", "b", "c", "d"],
      ["e", "d", "c", "b", "a"],
      ["a", "c", "b", "e", "d"],
      ["a", "b", "c", "d", "e"],
    ]) {
      const moves = reorderMoves("p", cur, target);
      expect(applyMoves(cur, moves)).toEqual(target);
    }
    expect(reorderMoves("p", cur, ["b", "c", "d", "e", "a"])).toHaveLength(1);
    expect(reorderMoves("p", cur, ["e", "d", "c", "b", "a"])).toHaveLength(4);
    expect(reorderMoves("p", cur, cur)).toEqual([]);
    expect(() => reorderMoves("p", cur, ["a"])).toThrow();
  });

  test("random permutations", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 300; k++) {
      const n = 1 + Math.floor(rand() * 12);
      const cur = Array.from({ length: n }, (_, i) => `n${i}`);
      const target = cur.slice().sort(() => rand() - 0.5);
      expect(applyMoves(cur, reorderMoves("p", cur, target))).toEqual(target);
    }
  });

  test("coalesceOps leaves unrelated ops alone", () => {
    const ops = [
      { op: "update" as const, id: "a", set: { x: 1 } },
      { op: "update" as const, id: "b", set: { x: 1 } },
      { op: "delete" as const, id: "a" },
    ];
    expect(coalesceOps(ops)).toEqual(ops);
  });
});
