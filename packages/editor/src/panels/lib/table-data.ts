import type { ChartNode } from "@desyn/schema";

/**
 * Chart data as an editable grid (row 0 = series names, column 0 = labels) and back, plus clipboard parsing
 * (TSV from spreadsheets, CSV with quotes).
 */

export type Grid = string[][];

export function chartToGrid(data: ChartNode["data"]): Grid {
  const header = ["", ...data.series.map((s) => s.name)];
  const rows = data.labels.map((label, i) => [
    label,
    ...data.series.map((s) => {
      const v = s.values[i];
      return v === undefined || !Number.isFinite(v) ? "" : String(v);
    }),
  ]);
  return [header, ...rows];
}

/** Parses a cell as a number ("1,234.5", "12%", "$3" all read as numbers); empty / invalid = 0. */
export function parseNumber(text: string): number {
  const cleaned = text
    .replace(/[\s$€£¥%]/g, "")
    .replace(/,(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function gridToChart(grid: Grid, previous: ChartNode["data"]): ChartNode["data"] {
  const header = grid[0] ?? [""];
  const body = grid.slice(1);
  const series = header.slice(1).map((name, c) => ({
    name: name.trim() || `Series ${c + 1}`,
    values: body.map((row) => parseNumber(row[c + 1] ?? "")),
    ...(previous.series[c]?.color ? { color: previous.series[c]?.color as string } : {}),
  }));
  return { labels: body.map((row, i) => (row[0] ?? "").trim() || `Item ${i + 1}`), series };
}

/** Clipboard text to rows of cells (tab-separated when tabs are present, else CSV). */
export function parseClipboard(text: string): Grid {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (text.includes("\t")) return lines.map((l) => l.split("\t"));
  return lines.map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Writes `block` into `grid` at (row, col), growing the grid as needed. */
export function pasteInto(grid: Grid, row: number, col: number, block: Grid): Grid {
  const next = grid.map((r) => [...r]);
  const width = Math.max(next[0]?.length ?? 1, col + Math.max(...block.map((r) => r.length)));
  for (const r of next) while (r.length < width) r.push("");
  block.forEach((cells, i) => {
    const target = row + i;
    while (next.length <= target) next.push(Array.from({ length: width }, () => ""));
    cells.forEach((v, j) => {
      (next[target] as string[])[col + j] = v;
    });
  });
  return next;
}
