import FlexSearch from "flexsearch";

/** One searchable unit: a page intro or one of its h2/h3 sections. */
export interface SearchRecord {
  id: number;
  /** Site path including the #anchor, without the base path. */
  href: string;
  /** Page title. */
  page: string;
  /** Sidebar section (e.g. "Self-hosting"). */
  section: string;
  /** Section heading, or the page title for the intro record. */
  heading: string;
  /** Identifiers defined in this section (env var names, endpoint paths and functions). */
  keys: string[];
  text: string;
}

export interface SearchIndexFile {
  version: 1;
  records: SearchRecord[];
}

export interface Segment {
  text: string;
  match: boolean;
}

export interface SearchHit {
  record: SearchRecord;
  score: number;
  snippet: Segment[];
}

const WEIGHTS = { key: 12, heading: 8, page: 5, text: 2 } as const;
const SNIPPET_RADIUS = 70;

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split text into highlighted / plain segments for the given query terms. */
export function highlight(text: string, terms: string[]): Segment[] {
  const usable = terms.filter((t) => t.length > 1 || terms.length === 1);
  if (usable.length === 0 || text === "") return [{ text, match: false }];
  const re = new RegExp(`(${usable.map(escapeRegExp).join("|")})`, "gi");
  const out: Segment[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), match: false });
    out.push({ text: m[0], match: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out;
}

/** A window of `text` around the first term occurrence, highlighted. */
export function snippet(text: string, terms: string[]): Segment[] {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) {
    const head = text.slice(0, SNIPPET_RADIUS * 2);
    return highlight(head + (text.length > head.length ? "…" : ""), terms);
  }
  let start = Math.max(0, at - SNIPPET_RADIUS);
  let end = Math.min(text.length, at + SNIPPET_RADIUS * 1.5);
  // Snap to word boundaries so the snippet does not start mid-word.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > at) end = space;
  }
  const body = text.slice(start, end);
  return highlight(`${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`, terms);
}

type FlexIndex = InstanceType<typeof FlexSearch.Index>;

/**
 * Appends the parts of snake_case identifiers (OLLAMA_ORIGINS → OLLAMA ORIGINS) so a search for
 * "ollama origins" finds text that only mentions the variable.
 */
export function expandIdentifiers(text: string): string {
  const parts = text.match(/[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+/g);
  if (!parts) return text;
  return `${text} ${parts.map((p) => p.replace(/_/g, " ")).join(" ")}`;
}

/** Queries that look like identifiers (env vars, paths, function names) use the key index. */
function looksLikeIdentifier(query: string): boolean {
  return /[_./:{}]/.test(query) || /^[A-Z0-9_]{3,}$/.test(query.trim());
}

function createIndex(): FlexIndex {
  // Normalize folds case and diacritics only; phonetic encoders conflate words like "crop" and
  // "group", which makes technical search noisy.
  return new FlexSearch.Index({
    tokenize: "forward",
    encoder: FlexSearch.Charset.Normalize,
    cache: 64,
  });
}

/**
 * Client-side full-text search over the static index. Three FlexSearch indexes (headings, page
 * titles, body text) are queried separately and blended with fixed weights, so a heading match
 * outranks a passing mention in body text.
 */
export class DocsSearch {
  private readonly records: Map<number, SearchRecord>;
  private readonly keys = createIndex();
  private readonly headings = createIndex();
  private readonly pages = createIndex();
  private readonly texts = createIndex();

  constructor(records: SearchRecord[]) {
    this.records = new Map(records.map((r) => [r.id, r]));
    for (const r of records) {
      if (r.keys.length) this.keys.add(r.id, r.keys.join(" "));
      this.headings.add(r.id, r.heading);
      this.pages.add(r.id, `${r.page} ${r.section}`);
      this.texts.add(r.id, expandIdentifiers(r.text));
    }
  }

  search(query: string, limit = 12): SearchHit[] {
    const terms = tokenizeQuery(query);
    if (terms.length === 0) return [];
    const q = terms.join(" ");
    const scores = new Map<number, number>();
    const add = (ids: (string | number)[], weight: number) => {
      ids.forEach((id, rank) => {
        const key = Number(id);
        scores.set(key, (scores.get(key) ?? 0) + weight * (1 - rank / (ids.length + 1)));
      });
    };
    const opts = { limit: 60, suggest: true } as const;
    if (looksLikeIdentifier(query))
      add(this.keys.search(q, opts) as (string | number)[], WEIGHTS.key);
    add(this.headings.search(q, opts) as (string | number)[], WEIGHTS.heading);
    add(this.pages.search(q, opts) as (string | number)[], WEIGHTS.page);
    add(this.texts.search(q, opts) as (string | number)[], WEIGHTS.text);

    const hits: SearchHit[] = [];
    for (const [id, base] of scores) {
      const record = this.records.get(id);
      if (!record) continue;
      const haystack = expandIdentifiers(
        `${record.heading} ${record.page} ${record.text}`,
      ).toLowerCase();
      const covered = terms.filter((t) => haystack.includes(t)).length / terms.length;
      const heading = record.heading.toLowerCase();
      const phrase = query.trim().toLowerCase();
      const exactHeading = heading === q ? 6 : heading.startsWith(q) ? 3 : 0;
      const exactKey = record.keys.some((k) => k.toLowerCase() === phrase) ? 10 : 0;
      const inText = terms.length > 1 && record.text.toLowerCase().includes(phrase) ? 3 : 0;
      // Records that contain every term literally rank above partial matches.
      const score = base * (0.15 + 0.85 * covered ** 2) + exactHeading + exactKey + inText;
      hits.push({ record, score, snippet: snippet(record.text, terms) });
    }
    hits.sort((a, b) => b.score - a.score || a.record.id - b.record.id);
    return hits.slice(0, limit);
  }
}
