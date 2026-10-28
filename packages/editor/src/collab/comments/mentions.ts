/**
 * @mentions in comment bodies. The body keeps the readable text ("@Ada Lovelace thoughts?"); the mentioned
 * user ids travel next to it (`mentions`), which is what the server validates and notifies.
 */

export interface MentionCandidate {
  id: string;
  name: string;
}

export interface MentionQuery {
  /** Index of the "@". */
  start: number;
  /** Text typed after the "@" up to the caret. */
  query: string;
}

const MAX_QUERY = 40;

/** The mention being typed at `caret`, if any ("@" at a word start, no line break, at most three words). */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && !/[\s([{"'“‘]/.test(prev)) return null; // e-mail addresses, not mentions
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n\r@]/.test(query)) return null;
  if (query.startsWith(" ")) return null;
  if ((query.match(/ /g) ?? []).length > 2) return null;
  return { start: at, query };
}

/** Replaces the typed mention with "@Name " and returns the new text and caret. */
export function insertMention(
  text: string,
  q: MentionQuery,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const insert = `@${name} `;
  const after = text.slice(caret).replace(/^ /, "");
  return { text: text.slice(0, q.start) + insert + after, caret: q.start + insert.length };
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase();
}

/** Members matching a query: name prefix, then word prefix, then substring; alphabetical within each. */
export function filterCandidates<T extends MentionCandidate>(
  members: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = fold(query.trim());
  const scored: { m: T; score: number }[] = [];
  for (const m of members) {
    const name = fold(m.name);
    let score: number;
    if (!q) score = 3;
    else if (name.startsWith(q)) score = 0;
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
    else if (name.includes(q)) score = 2;
    else continue;
    scored.push({ m, score });
  }
  scored.sort((a, b) => a.score - b.score || a.m.name.localeCompare(b.m.name));
  return scored.slice(0, limit).map((s) => s.m);
}

/** Ids of picked members whose "@Name" is still in the body (deleted mentions are dropped). */
export function mentionsInBody(body: string, picked: readonly MentionCandidate[]): string[] {
  const out: string[] = [];
  for (const m of picked) {
    if (out.includes(m.id)) continue;
    if (containsMention(body, m.name)) out.push(m.id);
  }
  return out;
}

function containsMention(body: string, name: string): boolean {
  const token = `@${name}`;
  let i = body.indexOf(token);
  while (i >= 0) {
    const before = i > 0 ? (body[i - 1] ?? "") : "";
    const after = body[i + token.length] ?? "";
    const startOk = !before || !/[\p{L}\p{N}_]/u.test(before);
    const endOk = !after || !/[\p{L}\p{N}_]/u.test(after);
    if (startOk && endOk) return true;
    i = body.indexOf(token, i + 1);
  }
  return false;
}

export interface BodySegment {
  text: string;
  /** Mentioned member id when this segment is a mention. */
  mention?: string;
}

/** Splits a body into plain text and mention segments (longest names first so "Ada Lovelace" beats "Ada"). */
export function segmentBody(body: string, mentioned: readonly MentionCandidate[]): BodySegment[] {
  const names = [...mentioned].sort((a, b) => b.name.length - a.name.length);
  const out: BodySegment[] = [];
  let plain = "";
  let i = 0;
  outer: while (i < body.length) {
    if (body[i] === "@") {
      const before = i > 0 ? (body[i - 1] ?? "") : "";
      if (!before || !/[\p{L}\p{N}_]/u.test(before)) {
        for (const m of names) {
          const token = `@${m.name}`;
          if (!m.name || !body.startsWith(token, i)) continue;
          const after = body[i + token.length] ?? "";
          if (after && /[\p{L}\p{N}_]/u.test(after)) continue;
          if (plain) out.push({ text: plain });
          plain = "";
          out.push({ text: token, mention: m.id });
          i += token.length;
          continue outer;
        }
      }
    }
    plain += body[i];
    i++;
  }
  if (plain) out.push({ text: plain });
  return out;
}
