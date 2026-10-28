"use client";

import { useEffect } from "react";
import type { EditorController } from "../../controller.ts";
import type { SlotProps } from "../../shell/extensions.ts";
import type { EditorState } from "../../store/editor-store.ts";
import { focusThread } from "../comments/focus.ts";
import { errorCode, errorMessage } from "../live.ts";
import { collabOf, readLastSeen } from "../state.ts";
import { type LocalPresence, PresencePublisher } from "./publisher.ts";
import { followRect, reducePresence, sameRect } from "./reduce.ts";

/** Own presence derived from editor state (cursor is tracked separately from pointer events). */
function presenceOf(s: EditorState): Omit<LocalPresence, "cursor"> {
  const v = s.viewport;
  return {
    selection: s.selection,
    viewport:
      v.width > 0 && v.height > 0
        ? {
            x: v.x,
            y: v.y,
            zoom: v.zoom,
            width: v.width,
            height: v.height,
            ...(s.pageId ? { pageId: s.pageId } : {}),
          }
        : null,
    editing: s.textEditing ? { nodeIds: [s.textEditing], kind: "text" } : null,
  };
}

function canvasElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-editor-canvas]");
}

/**
 * Invisible controller (root slot): publishes the own presence, subscribes to collaborators and comment
 * threads, and drives follow mode. Mounted once per editor.
 */
export function CollabController({ editor }: SlotProps) {
  useEffect(() => {
    const services = collabOf(editor);
    if (!services) return;
    const { backend, store, sessionId } = services;
    const offs: (() => void)[] = [];

    // Own presence -----------------------------------------------------------------------------------
    const publisher = new PresencePublisher({
      sessionId,
      send: (args) => backend.presence.heartbeat(args),
      onColor: (color) => {
        if (store.getState().ownColor !== color) store.setState({ ownColor: color });
      },
      onError: (e) => {
        if (errorCode(e) === "FORBIDDEN" || errorCode(e) === "NOT_FOUND") publisher.stop();
      },
    });
    publisher.update(presenceOf(editor.getState()));
    publisher.start();
    offs.push(
      editor.store.subscribe((s, prev) => {
        if (
          s.selection !== prev.selection ||
          s.viewport !== prev.viewport ||
          s.pageId !== prev.pageId ||
          s.textEditing !== prev.textEditing
        ) {
          publisher.update(presenceOf(s));
        }
      }),
    );

    const onPointerMove = (e: PointerEvent) => {
      const canvas = canvasElement();
      const client = editor.engineClient;
      const pageId = editor.getState().pageId;
      if (!canvas || !client || !pageId) return;
      const target = e.target instanceof Node ? e.target : null;
      if (!target || !canvas.contains(target)) {
        publisher.update({ cursor: null });
        return;
      }
      const r = canvas.getBoundingClientRect();
      const p = client.screenToPage({ x: e.clientX - r.left, y: e.clientY - r.top });
      publisher.update({ cursor: { x: round2(p.x), y: round2(p.y), pageId } });
    };
    const onLeave = () => publisher.update({ cursor: null });
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    offs.push(() => {
      document.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    });

    const leave = () => {
      publisher.stop();
      void backend.presence.leave(sessionId).catch(() => {});
    };
    // A page restored from the back/forward cache comes back after `pagehide` removed its presence.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      publisher.update(presenceOf(editor.getState()));
      publisher.start();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", onShow);
    offs.push(
      () => window.removeEventListener("pagehide", leave),
      () => window.removeEventListener("pageshow", onShow),
      leave,
    );

    // Collaborators + comments ------------------------------------------------------------------------
    offs.push(
      backend.presence.list().subscribe(
        (rows) => store.setState({ rows }),
        () => {},
      ),
      backend.comments.list(true).subscribe(
        (threads) => store.setState({ threads, commentsError: null }),
        (e) => store.setState({ commentsError: { message: errorMessage(e), code: errorCode(e) } }),
      ),
    );
    const userId = editor.getState().user?.id ?? "anon";
    store.setState({ lastSeenAt: readLastSeen(userId, editor.getState().designId) });
    offs.push(
      editor.store.subscribe((s, prev) => {
        if (s.user?.id !== prev.user?.id) {
          store.setState({ lastSeenAt: readLastSeen(s.user?.id ?? "anon", s.designId) });
        }
      }),
    );

    offs.push(followMode(editor, services.store, sessionId));
    offs.push(openLinkedThread(editor, services.store));
    return () => {
      for (const off of offs.reverse()) off();
    };
  }, [editor]);
  return null;
}

/** URL parameter of comment links (mention e-mails link to `/design/<id>?comment=<threadId>`). */
export const COMMENT_PARAM = "comment";

/**
 * Opens the thread a comment link points at once the design, the canvas and the threads are loaded, then
 * drops the parameter from the address so a reload does not open it again.
 */
function openLinkedThread(
  editor: EditorController,
  store: NonNullable<ReturnType<typeof collabOf>>["store"],
): () => void {
  let threadId: string | null = null;
  try {
    threadId = new URLSearchParams(window.location.search).get(COMMENT_PARAM);
  } catch {
    threadId = null;
  }
  if (!threadId) return () => {};
  let done = false;
  const forget = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(COMMENT_PARAM);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // Sandboxed frames may refuse history changes; the thread is open either way.
    }
  };
  const attempt = () => {
    if (done) return;
    const threads = store.getState().threads;
    const s = editor.getState();
    if (!threads || !editor.design || s.engine.status !== "ready") return;
    done = true;
    off1();
    off2();
    forget();
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) {
      editor.notify({
        kind: "info",
        title: "That comment is no longer here",
        description: "It was deleted, or you no longer have access to it.",
      });
      return;
    }
    if (thread.resolved) {
      store.setState((st) => ({ filters: { ...st.filters, status: "all" } }));
    }
    focusThread(editor, thread);
  };
  const off1 = store.subscribe(attempt);
  const off2 = editor.store.subscribe(attempt);
  attempt();
  return () => {
    done = true;
    off1();
    off2();
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Follow mode: mirror the followed session's page and visible area until the user navigates. */
function followMode(
  editor: EditorController,
  store: NonNullable<ReturnType<typeof collabOf>>["store"],
  sessionId: string,
): () => void {
  let applied: { x: number; y: number; w: number; h: number } | null = null;
  const apply = () => {
    const s = store.getState();
    if (!s.following) {
      applied = null;
      return;
    }
    const target = reducePresence(s.rows, {
      sessionId,
      userId: editor.getState().user?.id ?? null,
      now: Date.now(),
    }).find((c) => c.sessionId === s.following);
    if (!target) {
      // They left: stop following quietly.
      store.setState({ following: null });
      return;
    }
    const f = followRect(target.viewport);
    if (!f) return;
    if (f.pageId && f.pageId !== editor.getState().pageId) {
      editor.setPage(f.pageId);
      applied = null;
    }
    if (applied && sameRect(applied, f.rect, editor.getState().viewport.zoom)) return;
    applied = f.rect;
    editor.engine.fit(f.rect, 0);
  };
  const off = store.subscribe((s, prev) => {
    if (s.following !== prev.following || (s.following && s.rows !== prev.rows)) apply();
  });
  // Own navigation ends follow mode (wheel / drag on the canvas, page switches, Escape).
  const stop = () => {
    if (store.getState().following) store.setState({ following: null });
  };
  const onCanvasInput = (e: Event) => {
    const canvas = canvasElement();
    if (canvas && e.target instanceof Node && canvas.contains(e.target)) stop();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && store.getState().following) {
      e.stopPropagation();
      stop();
    }
  };
  window.addEventListener("wheel", onCanvasInput, { capture: true, passive: true });
  window.addEventListener("pointerdown", onCanvasInput, { capture: true });
  window.addEventListener("keydown", onKey, { capture: true });
  return () => {
    off();
    window.removeEventListener("wheel", onCanvasInput, { capture: true });
    window.removeEventListener("pointerdown", onCanvasInput, { capture: true });
    window.removeEventListener("keydown", onKey, { capture: true });
  };
}
