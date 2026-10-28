import { approxBounds, unionRects } from "@desyn/doc-ops";
import type { Design, Id } from "@desyn/schema";
import type { PresenceCursor, PresenceEditing, PresenceRow, PresenceViewport } from "../backend.ts";

/**
 * Pure reductions of `presence.list` rows into what the editor draws: collaborators (other sessions), the
 * avatar stack (one entry per person), cursors and selections on the current page, "editing" markers and the
 * rectangle to show when following someone. No React, no backend: unit tested.
 */

export interface Collaborator {
  sessionId: string;
  userId: string;
  name: string;
  image: string | null;
  color: string;
  cursor: PresenceCursor | null;
  selection: string[];
  viewport: PresenceViewport | null;
  editing: PresenceEditing | null;
  updatedAt: number;
  /** Another tab / device of the signed-in user. */
  isSelf: boolean;
  guest: boolean;
}

export interface PresenceSelf {
  sessionId: string;
  userId: string | null;
  now: number;
}

/** Other sessions on the design: own session and expired rows removed, newest first per person. */
export function reducePresence(rows: readonly PresenceRow[], self: PresenceSelf): Collaborator[] {
  const bySession = new Map<string, PresenceRow>();
  for (const row of rows) {
    if (row.sessionId === self.sessionId || row.expiresAt <= self.now) continue;
    const prev = bySession.get(row.sessionId);
    if (!prev || row.updatedAt > prev.updatedAt) bySession.set(row.sessionId, row);
  }
  const out: Collaborator[] = [];
  for (const row of bySession.values()) {
    out.push({
      sessionId: row.sessionId,
      userId: row.userId,
      name: displayName(row),
      image: row.image,
      color: row.color,
      cursor: row.cursor,
      selection: row.selection,
      viewport: row.viewport,
      editing: row.editing,
      updatedAt: row.updatedAt,
      isSelf: self.userId !== null && row.userId === self.userId,
      guest: row.userId.startsWith("guest:"),
    });
  }
  // Stable order: people first by name, then the most recently active session first.
  return out.sort(
    (a, b) =>
      Number(a.isSelf) - Number(b.isSelf) ||
      a.name.localeCompare(b.name) ||
      b.updatedAt - a.updatedAt ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

function displayName(row: PresenceRow): string {
  const name = row.name.trim();
  if (name) return name;
  return row.userId.startsWith("guest:") ? "Guest" : "Collaborator";
}

export interface PersonPresence {
  /** userId. */
  key: string;
  name: string;
  image: string | null;
  color: string;
  /** Most recently active session: the one "follow" follows. */
  primary: Collaborator;
  sessions: Collaborator[];
}

/** One entry per person for the avatar stack (own other sessions excluded). */
export function peopleOf(collaborators: readonly Collaborator[]): PersonPresence[] {
  const map = new Map<string, PersonPresence>();
  for (const c of collaborators) {
    if (c.isSelf) continue;
    // Guests have one id per session (`guest:<sessionId>`), so each guest is their own person.
    const key = c.userId;
    const entry = map.get(key);
    if (!entry) {
      map.set(key, {
        key,
        name: c.name,
        image: c.image,
        color: c.color,
        primary: c,
        sessions: [c],
      });
      continue;
    }
    entry.sessions.push(c);
    if (c.updatedAt > entry.primary.updatedAt) {
      entry.primary = c;
      entry.color = c.color;
    }
    entry.image ??= c.image;
  }
  return [...map.values()];
}

export interface RemoteCursor {
  sessionId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  editing: PresenceEditing | null;
}

/** Cursors of other sessions on `pageId` (page coordinates). */
export function cursorsOnPage(
  collaborators: readonly Collaborator[],
  pageId: Id | null,
): RemoteCursor[] {
  if (!pageId) return [];
  const out: RemoteCursor[] = [];
  for (const c of collaborators) {
    const cur = c.cursor;
    if (!cur || cur.pageId !== pageId) continue;
    if (!Number.isFinite(cur.x) || !Number.isFinite(cur.y)) continue;
    out.push({
      sessionId: c.sessionId,
      name: c.name,
      color: c.color,
      x: cur.x,
      y: cur.y,
      editing: c.editing,
    });
  }
  return out;
}

export interface RemoteSelection {
  sessionId: string;
  name: string;
  color: string;
  /** Page-space bounds of each selected node on the page. */
  rects: { id: Id; x: number; y: number; width: number; height: number }[];
  /** Union of the rects (where the name tag goes). */
  bounds: { x: number; y: number; width: number; height: number };
}

/** Selections of other sessions that are on `pageId` (unknown / other-page / page nodes skipped). */
export function selectionsOnPage(
  collaborators: readonly Collaborator[],
  design: Design | null,
  pageId: Id | null,
): RemoteSelection[] {
  if (!design || !pageId) return [];
  const out: RemoteSelection[] = [];
  for (const c of collaborators) {
    const rects: RemoteSelection["rects"] = [];
    for (const id of c.selection) {
      const node = design.nodes[id];
      if (!node || node.type === "page" || node.type === "root") continue;
      if (pageIdOf(design, id) !== pageId) continue;
      const b = approxBounds(design, id, "page");
      if (b) rects.push({ id, ...b });
    }
    const bounds = unionRects(rects);
    if (rects.length > 0 && bounds) {
      out.push({ sessionId: c.sessionId, name: c.name, color: c.color, rects, bounds });
    }
  }
  return out;
}

function pageIdOf(design: Design, id: Id): Id | null {
  let cur = design.nodes[id];
  let guard = 0;
  while (cur && cur.type !== "page" && guard++ < 1000) {
    cur = cur.parent ? design.nodes[cur.parent] : undefined;
  }
  return cur?.type === "page" ? cur.id : null;
}

export interface EditingMarker {
  nodeId: Id;
  sessionId: string;
  name: string;
  color: string;
  kind: PresenceEditing["kind"];
  label: string;
}

/** "Ada is typing" / "AI is editing" markers by node (first session wins per node). */
export function editingMarkers(collaborators: readonly Collaborator[]): Map<Id, EditingMarker> {
  const out = new Map<Id, EditingMarker>();
  for (const c of collaborators) {
    const e = c.editing;
    if (!e) continue;
    const label =
      e.label?.trim() ||
      (e.kind === "text"
        ? `${c.name} is typing`
        : e.kind === "ai"
          ? `AI is editing for ${c.name}`
          : `${c.name} is moving`);
    for (const nodeId of e.nodeIds) {
      if (!out.has(nodeId))
        out.set(nodeId, {
          nodeId,
          sessionId: c.sessionId,
          name: c.name,
          color: c.color,
          kind: e.kind,
          label,
        });
    }
  }
  return out;
}

/**
 * The page rectangle another session sees, for follow mode (`fit` it into the own view). Null when the
 * viewport is unknown or degenerate.
 */
export function followRect(
  viewport: PresenceViewport | null,
): { pageId: Id | null; rect: { x: number; y: number; w: number; h: number } } | null {
  if (!viewport) return null;
  const { x, y, zoom, width, height } = viewport;
  if (![x, y, zoom].every(Number.isFinite) || zoom <= 0) return null;
  if (!width || !height || !(width > 0) || !(height > 0)) return null;
  return { pageId: viewport.pageId ?? null, rect: { x, y, w: width / zoom, h: height / zoom } };
}

/** Same rectangle within half a screen pixel of the own view (no refit needed). */
export function sameRect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  zoom: number,
): boolean {
  const tol = 0.5 / Math.max(zoom, 1e-6);
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.w - b.w) <= tol &&
    Math.abs(a.h - b.h) <= tol
  );
}

/** Screen position (CSS px relative to the canvas) of a page point for a view. */
export function toScreen(
  view: { x: number; y: number; zoom: number },
  p: { x: number; y: number },
): { x: number; y: number } {
  return { x: (p.x - view.x) * view.zoom, y: (p.y - view.y) * view.zoom };
}
