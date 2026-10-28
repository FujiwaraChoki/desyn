"use client";

import { Avatar, cn, IconButton } from "@desyn/ui";
import { MessageCirclePlus, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import type { CommentThread } from "../backend.ts";
import { toScreen } from "../presence/reduce.ts";
import { useCollab, useCollabStore } from "../state.ts";
import { useEntered } from "../ui.ts";
import { useCommentAccess, useCommentAction } from "./access.ts";
import { anchorAt, type ResolvedPin, resolvePin } from "./anchor.ts";
import { Composer } from "./composer.tsx";
import { pinNumbers, unreadIn } from "./model.ts";
import { ThreadView } from "./thread.tsx";

const CARD_W = 320;

interface PlacedPin {
  thread: CommentThread;
  pin: ResolvedPin;
  number: number;
  unread: boolean;
}

/** Pins are shown while commenting, while the comments panel is open, or while a thread is open. */
function usePinsVisible(): boolean {
  const tool = useEditorStore((s) => s.heldTool ?? s.tool);
  const panel = useEditorStore((s) => s.panels.left);
  const mode = useEditorStore((s) => s.mode);
  const active = useCollabStore((s) => s.activeThread !== null || s.draft !== null);
  return tool === "comment" || panel === "comments" || mode === "comment" || active;
}

/** Room the pin itself takes to the right of its tip (avatar + number) and above it. */
const PIN_W = 60;
const PIN_H = 30;

/**
 * Keeps a floating card inside the canvas, next to the pin without covering it: to the right of the pin
 * body, or to the left of the tip when there is no room; shifted vertically to stay inside.
 */
function cardPosition(
  pin: { x: number; y: number },
  size: { w: number; h: number },
  bounds: { w: number; h: number },
): { left: number; top: number } {
  const gap = 10;
  let left = pin.x + PIN_W + gap;
  if (left + size.w > bounds.w - 8) left = pin.x - gap - size.w;
  left = Math.max(8, Math.min(left, bounds.w - size.w - 8));
  let top = pin.y - PIN_H;
  top = Math.max(8, Math.min(top, bounds.h - size.h - 8));
  return { left, top };
}

function FloatingCard({
  at,
  children,
  onClose,
  label,
}: {
  at: { x: number; y: number };
  children: React.ReactNode;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: CARD_W, h: 160 });
  const [bounds, setBounds] = useState({ w: 1200, h: 800 });
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const measure = () => {
      setSize({ w: el.offsetWidth, h: el.offsetHeight });
      setBounds({ w: parent.clientWidth, h: parent.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  const pos = cardPosition(at, size, bounds);
  const entered = useEntered();
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "pointer-events-auto absolute z-[8] flex max-h-[min(520px,calc(100%-16px))] flex-col overflow-hidden rounded-panel border border-line-subtle bg-surface-1/95 shadow-popover backdrop-blur-xl transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
        entered ? "scale-100 opacity-100" : "scale-[0.97] opacity-0",
      )}
      style={{ left: pos.left, top: pos.top, width: CARD_W }}
    >
      <div className="absolute top-2 right-2 z-10">
        <IconButton label="Close" size="xs" variant="ghost" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="min-h-0 overflow-y-auto p-3 pr-9">{children}</div>
    </div>
  );
}

function Pin({
  placed,
  at,
  active,
  onOpen,
}: {
  placed: PlacedPin;
  at: { x: number; y: number };
  active: boolean;
  onOpen: () => void;
}) {
  const { thread, number, unread, pin } = placed;
  const label = `Comment ${number} by ${thread.author.name}${thread.resolved ? ", resolved" : ""}${
    unread ? ", unread" : ""
  }`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={active}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onOpen}
      className={cn(
        "group/pin pointer-events-auto absolute flex origin-bottom-left items-center gap-1 rounded-full rounded-bl-[3px] border p-[3px] shadow-popover transition-[scale,opacity] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "z-[7] scale-110 border-accent bg-accent-solid"
          : "z-[6] border-line bg-surface-1 hover:scale-105",
        thread.resolved && !active && "opacity-55",
        pin.detached && "border-dashed",
      )}
      // left / top, not a transform: the hover / active `scale` would also scale a translate.
      style={{ left: at.x, top: at.y - PIN_H }}
    >
      <Avatar name={thread.author.name} src={thread.author.image} size="xs" />
      <span
        className={cn(
          "pr-1.5 text-[11px] font-semibold tabular-nums",
          active ? "text-accent-ink" : "text-fg",
        )}
      >
        {number}
      </span>
      {unread && !active ? (
        <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-surface-1" />
      ) : null}
    </button>
  );
}

/**
 * Comment pins on the canvas (`canvas.overlay`) and the comment tool: with the tool active a click on the
 * canvas drops a draft pin (anchored to the layer under it) with a composer; clicking a pin opens its thread.
 */
export function CommentPins(_props: SlotProps) {
  const editor = useEditor();
  const { store, backend } = useCollab();
  const access = useCommentAccess();
  const run = useCommentAction();
  const visible = usePinsVisible();
  const tool = useEditorStore((s) => s.heldTool ?? s.tool);
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const userId = useEditorStore((s) => s.user?.id ?? null);
  const ready = useEditorStore((s) => s.engine.status === "ready");
  const vx = useEditorStore((s) => s.viewport.x);
  const vy = useEditorStore((s) => s.viewport.y);
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const threads = useCollabStore((s) => s.threads);
  const activeThread = useCollabStore((s) => s.activeThread);
  const draft = useCollabStore((s) => s.draft);
  const statusFilter = useCollabStore((s) => s.filters.status);
  const panelOpen = useEditorStore((s) => s.panels.left === "comments");
  const lastSeenAt = useCollabStore((s) => s.lastSeenAt);
  const view = { x: vx, y: vy, zoom };

  const placed = useMemo<PlacedPin[]>(() => {
    if (!design || !threads) return [];
    const numbers = pinNumbers(threads);
    const out: PlacedPin[] = [];
    for (const thread of threads) {
      const showResolved = thread.id === activeThread || (panelOpen && statusFilter !== "open");
      if (thread.resolved && !showResolved) continue;
      const pin = resolvePin(design, thread);
      if (!pin || pin.pageId !== pageId) continue;
      out.push({
        thread,
        pin,
        number: numbers.get(thread.id) ?? 0,
        unread: unreadIn(thread, userId, lastSeenAt) > 0 && lastSeenAt !== null,
      });
    }
    // Oldest at the bottom, the open one on top.
    return out.sort((a, b) => a.number - b.number);
  }, [design, threads, pageId, activeThread, panelOpen, statusFilter, userId, lastSeenAt]);

  const commenting = tool === "comment" && access.canComment;

  // Escape closes the open thread / draft.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = store.getState();
      if (s.draft || s.activeThread) {
        store.setState({ draft: null, activeThread: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  if (!ready || !design) return null;

  const onCanvasPointerDown = async (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const s = store.getState();
    // First click outside closes an open thread / draft instead of starting a new one.
    if (s.activeThread || s.draft) {
      store.setState({ activeThread: null, draft: null });
      return;
    }
    const client = editor.engineClient;
    const page = editor.getState().pageId;
    if (!client || !page) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const point = client.screenToPage(screen);
    let nodeId: string | null = null;
    try {
      const hit = await client.hitTestScreen(screen, { deep: true, includeLocked: true });
      nodeId = hit.id;
    } catch {
      nodeId = null;
    }
    const anchor = anchorAt(editor.design ?? design, page, point, nodeId);
    store.setState({
      draft: { pageId: page, x: point.x, y: point.y, nodeId: anchor.nodeId },
      activeThread: null,
    });
  };

  const active = placed.find((p) => p.thread.id === activeThread);
  const draftOnPage = draft && draft.pageId === pageId ? draft : null;

  if (!visible && !draftOnPage) return null;

  return (
    // `data-canvas-chrome`: the canvas interaction layer leaves pointer input inside to these pins and cards.
    <div
      data-canvas-chrome=""
      className="pointer-events-none absolute inset-0 z-[6] overflow-hidden"
    >
      {commenting ? (
        <div
          className="pointer-events-auto absolute inset-0"
          style={{ cursor: "copy" }}
          onPointerDown={(e) => void onCanvasPointerDown(e)}
        />
      ) : (activeThread && !panelOpen) || draftOnPage ? (
        // Outside comment mode a click on empty canvas only closes an open card.
        <div
          className="pointer-events-auto absolute inset-0"
          onPointerDown={() => store.setState({ activeThread: null, draft: null })}
        />
      ) : null}
      {placed.map((p) => (
        <Pin
          key={p.thread.id}
          placed={p}
          at={toScreen(view, p.pin)}
          active={p.thread.id === activeThread}
          onOpen={() =>
            store.setState({
              activeThread: p.thread.id === activeThread ? null : p.thread.id,
              draft: null,
            })
          }
        />
      ))}
      {active && !panelOpen ? (
        <FloatingCard
          at={toScreen(view, active.pin)}
          label={`Comment thread ${active.number}`}
          onClose={() => store.setState({ activeThread: null })}
        >
          <ThreadView thread={active.thread} access={access} number={active.number} />
        </FloatingCard>
      ) : null}
      {draftOnPage ? (
        <>
          <div
            className="absolute top-0 left-0 grid size-7 place-items-center rounded-full rounded-bl-[3px] border border-accent bg-accent-solid text-accent-ink shadow-popover"
            style={{
              transform: `translate(${toScreen(view, draftOnPage).x}px, ${toScreen(view, draftOnPage).y - 28}px)`,
            }}
          >
            <MessageCirclePlus className="size-3.5" />
          </div>
          <FloatingCard
            at={toScreen(view, draftOnPage)}
            label="New comment"
            onClose={() => store.setState({ draft: null })}
          >
            <p className="mb-2 font-serif text-lg leading-none text-fg">
              new <em className="text-accent">comment</em>
            </p>
            {draftOnPage.nodeId ? (
              <p className="mb-2 truncate text-[11px] text-fg-muted">
                On {design.nodes[draftOnPage.nodeId]?.name ?? "layer"}
              </p>
            ) : null}
            <Composer
              placeholder="Add a comment, @ to mention"
              submitLabel="Comment"
              autoFocus
              onCancel={() => store.setState({ draft: null })}
              onSubmit={async (body, mentions) => {
                const d = editor.design ?? design;
                const anchor = anchorAt(
                  d,
                  draftOnPage.pageId,
                  { x: draftOnPage.x, y: draftOnPage.y },
                  draftOnPage.nodeId,
                );
                let id = "";
                const ok = await run("Couldn't post the comment", async () => {
                  id = await backend.comments.create({
                    body,
                    mentions,
                    pageId: anchor.pageId,
                    x: anchor.x,
                    y: anchor.y,
                    ...(anchor.nodeId ? { nodeId: anchor.nodeId } : {}),
                  });
                });
                if (ok) {
                  store.setState({ draft: null, activeThread: id || null });
                  editor.telemetry("comment_created", {
                    anchored: anchor.nodeId !== null,
                    mentions: mentions.length,
                  });
                }
                return ok;
              }}
            />
          </FloatingCard>
        </>
      ) : null}
    </div>
  );
}

export { cardPosition };
