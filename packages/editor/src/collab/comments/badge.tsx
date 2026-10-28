"use client";

import { cn, Tooltip } from "@desyn/ui";
import { MessageCircle } from "lucide-react";
import { useMemo } from "react";
import { useEditor, useEditorStore, useShortcutLabel } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { useCollabStore } from "../state.ts";
import { unreadCount } from "./model.ts";

/** Top bar button (`topbar.actions`): opens the comments panel; the sun badge counts unread comments. */
export function CommentsButton(_props: SlotProps) {
  const editor = useEditor();
  const threads = useCollabStore((s) => s.threads);
  const lastSeenAt = useCollabStore((s) => s.lastSeenAt);
  const userId = useEditorStore((s) => s.user?.id ?? null);
  const open = useEditorStore((s) => s.panels.left === "comments");
  const shortcut = useShortcutLabel("panel.comments");
  const unread = useMemo(
    () => (threads ? unreadCount(threads, userId, lastSeenAt) : 0),
    [threads, userId, lastSeenAt],
  );
  const label = unread > 0 ? `Comments, ${unread} unread` : "Comments";
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={open}
        onClick={() => editor.toggleLeftPanel("comments")}
        className={cn(
          "relative grid size-8 place-items-center rounded-[8px] text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring",
          open && "bg-accent-tint text-accent hover:bg-accent-tint hover:text-accent",
        )}
      >
        <MessageCircle className="size-4" />
        {unread > 0 ? (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-solid px-1 text-[9px] font-bold tabular-nums text-accent-ink ring-2 ring-surface-1"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
