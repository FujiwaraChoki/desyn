import type { VersionRow } from "../backend.ts";

export type VersionFilter = "all" | "named" | "auto";

export interface VersionGroup {
  /** Day label ("Today", "Yesterday", "Mon, Oct 12"). */
  label: string;
  versions: VersionRow[];
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(t: number, now = Date.now()): string {
  if (dayKey(t) === dayKey(now)) return "Today";
  if (dayKey(t) === dayKey(now - 86_400_000)) return "Yesterday";
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Versions newest first, filtered and grouped by day. */
export function groupVersions(
  versions: readonly VersionRow[],
  filter: VersionFilter,
  now = Date.now(),
): VersionGroup[] {
  const rows = versions
    .filter((v) => (filter === "named" ? !v.auto : filter === "auto" ? v.auto : true))
    .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
  const groups: VersionGroup[] = [];
  for (const v of rows) {
    const label = dayLabel(v.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.versions.push(v);
    else groups.push({ label, versions: [v] });
  }
  return groups;
}

/** Default name offered when naming the current state. */
export function defaultVersionName(now = Date.now()): string {
  const d = new Date(now);
  return `Version of ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** Server rule: 1 to 100 characters after trimming and collapsing whitespace. */
export function cleanVersionName(name: string): string | null {
  const n = name.trim().replace(/\s+/g, " ");
  return n.length >= 1 && n.length <= 100 ? n : null;
}
