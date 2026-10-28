// RFC 4180 CSV parsing (quoted fields, escaped quotes, CRLF/LF, BOM, configurable delimiter with auto-detect).

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  return counts.sort((a, b) => b.n - a.n)[0]?.n ? (counts[0] as { d: string }).d : ",";
}

/** Parses CSV text into raw records. */
export function parseCsvRecords(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const delim = delimiter ?? detectDelimiter(src);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.length === 0) {
      quoted = true;
      i++;
    } else if (c === delim) {
      record.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new Error("unterminated quoted field in CSV");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Parses CSV with a header row; header names are trimmed and must be unique. */
export function parseCsv(text: string, delimiter?: string): CsvTable {
  const records = parseCsvRecords(text, delimiter);
  const [head, ...body] = records;
  if (!head) return { headers: [], rows: [] };
  const headers = head.map((h) => h.trim());
  const dup = headers.find((h, i) => headers.indexOf(h) !== i);
  if (dup) throw new Error(`duplicate CSV column "${dup}"`);
  return {
    headers,
    rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))),
  };
}
