import type { CommentThread, CommentView } from "../backend.ts";
import type { CommentFilters } from "../state.ts";

/** Filtering, numbering and unread counting of comment threads (pure; the panel, pins and badge share it). */

export interface ThreadContext {
  userId: string | null;
  pageId: string | null;
}

export function mentionsUser(thread: CommentThread, userId: string | null): boolean {
  if (!userId) return false;
  return (
    thread.mentions.includes(userId) || thread.replies.some((r) => r.mentions.includes(userId))
  );
}

export function involvesUser(thread: CommentThread, userId: string | null): boolean {
  if (!userId) return false;
  return thread.author.id === userId || thread.replies.some((r) => r.author.id === userId);
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase();
}

export function threadMatches(thread: CommentThread, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const parts: CommentView[] = [thread, ...thread.replies];
  return parts.some((c) => fold(c.body).includes(q) || fold(c.author.name).includes(q));
}

/** Threads matching the filters, most recent activity first. */
export function filterThreads(
  threads: readonly CommentThread[],
  filters: CommentFilters,
  ctx: ThreadContext,
): CommentThread[] {
  return threads
    .filter((t) => {
      if (filters.status === "open" && t.resolved) return false;
      if (filters.status === "resolved" && !t.resolved) return false;
      if (filters.scope === "page" && t.pageId !== ctx.pageId) return false;
      if (filters.scope === "mine" && !involvesUser(t, ctx.userId)) return false;
      if (filters.scope === "mentions" && !mentionsUser(t, ctx.userId)) return false;
      return threadMatches(t, filters.query);
    })
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Pin numbers: 1, 2, 3... in creation order (stable while threads are added). */
export function pinNumbers(threads: readonly CommentThread[]): Map<string, number> {
  const sorted = [...threads].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return new Map(sorted.map((t, i) => [t.id, i + 1]));
}

/** Comments by others newer than `lastSeenAt` (root posts and replies), per thread. */
export function unreadIn(
  thread: CommentThread,
  userId: string | null,
  lastSeenAt: number | null,
): number {
  const since = lastSeenAt ?? Number.NEGATIVE_INFINITY;
  let n = 0;
  for (const c of [thread, ...thread.replies]) {
    if (c.deleted) continue;
    if (userId && c.author.id === userId) continue;
    if (c.createdAt > since) n++;
  }
  return n;
}

/**
 * Unread badge count: new comments by others since the panel was last opened (open threads only). On a
 * first visit (`lastSeenAt` null) only comments that mention the user count, so old discussions do not
 * shout at newcomers.
 */
export function unreadCount(
  threads: readonly CommentThread[],
  userId: string | null,
  lastSeenAt: number | null,
): number {
  let n = 0;
  for (const t of threads) {
    if (t.resolved) continue;
    if (lastSeenAt === null) {
      if (mentionsUser(t, userId)) n++;
      continue;
    }
    n += unreadIn(t, userId, lastSeenAt);
  }
  return n;
}

/** Latest activity time over threads and replies (what "seen" is set to when the panel shows them). */
export function latestActivity(threads: readonly CommentThread[]): number {
  let t = 0;
  for (const th of threads) {
    t = Math.max(t, th.lastActivityAt, th.createdAt);
    for (const r of th.replies) t = Math.max(t, r.createdAt);
  }
  return t;
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}
