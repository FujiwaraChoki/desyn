import type { TextRun, TextStyle } from "@desyn/schema";
import { describe, expect, it } from "vitest";
import {
  applyRunStyle,
  diffText,
  normalizeRuns,
  rangeHasStyle,
  replaceText,
  runsText,
  textTransaction,
} from "../src/text-ops";

const bold = { fontWeight: 700 } as const;
const runs: TextRun[] = [{ text: "Hello " }, { text: "bold", style: bold }, { text: " world" }];
const base = { fontWeight: 400, fontStyle: "normal", decoration: "none" } as unknown as TextStyle;

describe("text ops", () => {
  it("inserts with the style of the character before the caret", () => {
    const r = replaceText(runs, 10, 10, "er");
    expect(runsText(r)).toBe("Hello bolder world");
    expect(r[1]).toEqual({ text: "bolder", style: bold });
    const atStart = replaceText(runs, 0, 0, ">");
    expect(atStart[0]).toEqual({ text: ">Hello " });
  });

  it("replaces across runs and merges equal neighbours", () => {
    const r = replaceText(runs, 3, 11, "p ");
    expect(runsText(r)).toBe("Help world");
    expect(r).toEqual([{ text: "Help world" }]);
    expect(replaceText(runs, 0, 16, "")).toEqual([]);
  });

  it("applies and clears styles on ranges", () => {
    const r = applyRunStyle(runs, 0, 5, { fontStyle: "italic" });
    expect(r[0]).toEqual({ text: "Hello", style: { fontStyle: "italic" } });
    expect(rangeHasStyle(r, 0, 5, "fontStyle", "italic", base)).toBe(true);
    expect(rangeHasStyle(r, 0, 6, "fontStyle", "italic", base)).toBe(false);
    const cleared = applyRunStyle(r, 0, 16, { fontStyle: null, fontWeight: null });
    expect(cleared).toEqual([{ text: "Hello bold world" }]);
  });

  it("normalizes runs", () => {
    expect(normalizeRuns([{ text: "" }, { text: "a", style: {} }, { text: "b" }])).toEqual([
      { text: "ab" },
    ]);
  });

  it("diffs edits without splitting surrogate pairs", () => {
    expect(diffText("abc", "abXc")).toEqual({ start: 2, end: 2, insert: "X" });
    expect(diffText("abc", "ac")).toEqual({ start: 1, end: 2, insert: "" });
    const before = "a\u{1F600}b";
    const after = "a\u{1F601}b";
    const d = diffText(before, after);
    expect(before.slice(0, d.start) + d.insert + before.slice(d.end)).toBe(after);
    expect(d.start).toBe(1);
    expect(d.insert).toBe("\u{1F601}");
  });

  it("builds a runs update transaction", () => {
    const t = textTransaction("node00000001", runs, { id: "tx0000000001", ts: 1 });
    expect(t.ops).toEqual([{ op: "update", id: "node00000001", set: { runs } }]);
    expect(t.source).toBe("user");
  });
});
