"use client";

import type { Design, Id } from "@desyn/schema";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useEditor } from "../context.tsx";
import type { EditorController } from "../controller.ts";
import type { CollabBackend, CommentThread, PresenceRow } from "./backend.ts";

/**
 * Collaboration state of one editor: presence rows, follow target, comment threads and UI (open thread,
 * draft pin, filters, last-seen time), version preview. A separate vanilla store so presence updates (several
 * per second with live cursors) never touch the editor store.
 */

export interface CommentDraft {
  pageId: Id;
  /** Page coordinates of the pin. */
  x: number;
  y: number;
  /** Layer under the pin (the thread follows it), or null for a free pin. */
  nodeId: Id | null;
}

export type CommentStatusFilter = "open" | "resolved" | "all";
export type CommentScopeFilter = "all" | "page" | "mine" | "mentions";

export interface CommentFilters {
  status: CommentStatusFilter;
  scope: CommentScopeFilter;
  query: string;
}

export interface VersionPreview {
  versionId: string;
  name: string;
  createdAt: number;
  auto: boolean;
  design: Design;
}

export interface CollabState {
  sessionId: string;
  /** Own cursor color as assigned by the server. */
  ownColor: string | null;
  rows: PresenceRow[];
  /** Session being followed (viewport follow mode). */
  following: string | null;
  threads: CommentThread[] | null;
  commentsError: { message: string; code: string | null } | null;
  activeThread: string | null;
  draft: CommentDraft | null;
  filters: CommentFilters;
  /** Comment activity newer than this (by others) counts as unread; null = never opened comments here. */
  lastSeenAt: number | null;
  versionPreview: VersionPreview | null;
}

export type CollabStore = StoreApi<CollabState>;

export interface CollabServices {
  backend: CollabBackend;
  store: CollabStore;
  sessionId: string;
}

const SESSION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Presence session id (`[A-Za-z0-9_-]{8,64}` on the server). */
export function newSessionId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += SESSION_ALPHABET[b % SESSION_ALPHABET.length];
  return out;
}

export function createCollabStore(sessionId: string): CollabStore {
  return createStore<CollabState>()(() => ({
    sessionId,
    ownColor: null,
    rows: [],
    following: null,
    threads: null,
    commentsError: null,
    activeThread: null,
    draft: null,
    filters: { status: "open", scope: "all", query: "" },
    lastSeenAt: null,
    versionPreview: null,
  }));
}

const registry = new WeakMap<EditorController, CollabServices>();

export function attachCollab(editor: EditorController, backend: CollabBackend): CollabServices {
  const existing = registry.get(editor);
  if (existing) return existing;
  const sessionId = newSessionId();
  const services: CollabServices = { backend, store: createCollabStore(sessionId), sessionId };
  registry.set(editor, services);
  return services;
}

export function detachCollab(editor: EditorController): void {
  registry.delete(editor);
}

/** Collaboration services of an editor (null when the host has no backend for them). */
export function collabOf(editor: EditorController): CollabServices | null {
  return registry.get(editor) ?? null;
}

export function useCollab(): CollabServices {
  const services = collabOf(useEditor());
  if (!services) throw new Error("Collaboration is not installed on this editor.");
  return services;
}

export function useCollabStore<T>(selector: (s: CollabState) => T): T {
  return useStore(useCollab().store, selector);
}

// ---------------------------------------------------------------------------------------------------------
// Last-seen comment time (per user and design, this browser)

const seenKey = (userId: string, designId: string) => `desyn-comments-seen:${userId}:${designId}`;

export function readLastSeen(userId: string, designId: string): number | null {
  try {
    const raw = localStorage.getItem(seenKey(userId, designId));
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLastSeen(userId: string, designId: string, at: number): void {
  try {
    localStorage.setItem(seenKey(userId, designId), String(at));
  } catch {
    // Private mode / blocked storage: the badge resets per session, nothing else breaks.
  }
}
