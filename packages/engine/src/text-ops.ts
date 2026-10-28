// Pure edits of a text node's styled runs, in UTF-16 indices (DOM offsets). Inserted text inherits the style of
// the character before the caret (like word processors); adjacent runs with equal styles are merged.
import type { Id, TextRun, TextStyle, Transaction } from "@desyn/schema";

export type RunStyle = Partial<TextStyle>;

export function runsText(runs: readonly TextRun[]): string {
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

function sameStyle(a: RunStyle | undefined, b: RunStyle | undefined): boolean {
  return JSON.stringify(sortKeys(a ?? {})) === JSON.stringify(sortKeys(b ?? {}));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort())
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function isEmptyStyle(s: RunStyle | undefined): boolean {
  return !s || Object.keys(s).length === 0;
}

function makeRun(text: string, style: RunStyle | undefined): TextRun {
  return isEmptyStyle(style) ? { text } : { text, style: { ...style } };
}

/** Merges neighbours with equal styles and drops empty runs. */
export function normalizeRuns(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (r.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, r.style)) {
      out[out.length - 1] = makeRun(last.text + r.text, last.style);
    } else {
      out.push(makeRun(r.text, r.style));
    }
  }
  return out;
}

/** Style override of the character at `index` (the run containing it). */
export function styleAt(runs: readonly TextRun[], index: number): RunStyle | undefined {
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (index >= pos && index < end) return r.style;
    pos = end;
  }
  return runs[runs.length - 1]?.style;
}

/** Style typed text gets at a caret: the character before it, else the first character. */
export function caretStyle(runs: readonly TextRun[], index: number): RunStyle | undefined {
  return index > 0 ? styleAt(runs, index - 1) : runs[0]?.style;
}

/** Splits runs at UTF-16 offsets (pieces keep their styles). */
function slice(runs: readonly TextRun[], start: number, end: number): TextRun[] {
  const out: TextRun[] = [];
  let pos = 0;
  for (const r of runs) {
    const rs = pos;
    const re = pos + r.text.length;
    pos = re;
    const a = Math.max(start, rs);
    const b = Math.min(end, re);
    if (b > a) out.push(makeRun(r.text.slice(a - rs, b - rs), r.style));
  }
  return out;
}

/** Replaces `[start, end)` with `insert`. */
export function replaceText(
  runs: readonly TextRun[],
  start: number,
  end: number,
  insert: string,
  insertStyle?: RunStyle,
): TextRun[] {
  const len = runsText(runs).length;
  const a = Math.max(0, Math.min(start, end, len));
  const b = Math.min(len, Math.max(start, end));
  const style = insertStyle ?? caretStyle(runs, a);
  return normalizeRuns([...slice(runs, 0, a), makeRun(insert, style), ...slice(runs, b, len)]);
}

/** Merges `patch` into the style of `[start, end)`; `null` values remove keys (back to the node style). */
export function applyRunStyle(
  runs: readonly TextRun[],
  start: number,
  end: number,
  patch: { [K in keyof TextStyle]?: TextStyle[K] | null },
): TextRun[] {
  const len = runsText(runs).length;
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(len, Math.max(start, end));
  if (b <= a) return normalizeRuns(runs);
  const mid = slice(runs, a, b).map((r) => {
    const next: Record<string, unknown> = { ...(r.style ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    return makeRun(r.text, next as RunStyle);
  });
  return normalizeRuns([...slice(runs, 0, a), ...mid, ...slice(runs, b, len)]);
}

/** Whether every character of `[start, end)` has `key: value` (inheriting `base` where runs do not override). */
export function rangeHasStyle<K extends keyof TextStyle>(
  runs: readonly TextRun[],
  start: number,
  end: number,
  key: K,
  value: TextStyle[K],
  base: TextStyle,
): boolean {
  const parts = slice(runs, Math.min(start, end), Math.max(start, end));
  if (parts.length === 0) return (caretStyle(runs, start)?.[key] ?? base[key]) === value;
  return parts.every((r) => (r.style?.[key] ?? base[key]) === value);
}

/** The edit as a transaction (one `update` of `runs`). */
export function textTransaction(
  nodeId: Id,
  runs: readonly TextRun[],
  meta: { id: Id; label?: string; ts?: number },
): Transaction {
  return {
    id: meta.id,
    label: meta.label ?? "Edit text",
    ops: [{ op: "update", id: nodeId, set: { runs } }],
    source: "user",
    ts: meta.ts ?? Date.now(),
  };
}

/** The smallest replacement that turns `before` into `after` (common prefix / suffix). */
export function diffText(
  before: string,
  after: string,
): { start: number; end: number; insert: string } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < max - p &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  ) {
    s++;
  }
  // Never split a surrogate pair.
  if (p > 0 && isHighSurrogate(before.charCodeAt(p - 1))) p--;
  if (s > 0 && isLowSurrogate(before.charCodeAt(before.length - s))) s--;
  return { start: p, end: before.length - s, insert: after.slice(p, after.length - s) };
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
