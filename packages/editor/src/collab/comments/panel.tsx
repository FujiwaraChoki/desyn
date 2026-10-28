"use client";

import {
  Avatar,
  Button,
  cn,
  EmptyState,
  Input,
  ProBadge,
  SegmentedControl,
  Select,
  Skeleton,
} from "@desyn/ui";
import { ChevronDown, MessageCirclePlus, MessagesSquare, Search } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import type { CommentThread } from "../backend.ts";
import {
  type CommentScopeFilter,
  type CommentStatusFilter,
  useCollab,
  useCollabStore,
  writeLastSeen,
} from "../state.ts";
import { useCommentAccess } from "./access.ts";
import { focusThread } from "./focus.ts";
import { filterThreads, latestActivity, pinNumbers, relativeTime, unreadIn } from "./model.ts";
import { ThreadView } from "./thread.tsx";

const SCOPES: { value: CommentScopeFilter; label: string }[] = [
  { value: "all", label: "All pages" },
  { value: "page", label: "This page" },
  { value: "mine", label: "Involving me" },
  { value: "mentions", label: "Mentions of me" },
];

const STATUSES: { value: CommentStatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function ThreadCard({
  thread,
  number,
  unread,
  expanded,
  onToggle,
}: {
  thread: CommentThread;
  number: number;
  unread: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const access = useCommentAccess();
  const replies = thread.replies.length;
  return (
    <li
      className={cn(
        "rounded-card border transition-colors",
        expanded
          ? "border-line bg-surface-2/60"
          : "border-transparent hover:border-line-subtle hover:bg-fg/[0.03]",
        thread.resolved && !expanded && "opacity-70",
      )}
    >
      {expanded ? (
        <div className="p-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded
            className="mb-2 flex w-full items-center gap-1 text-[11px] text-fg-muted hover:text-fg"
          >
            <ChevronDown className="size-3 rotate-180" />
            Collapse
          </button>
          <ThreadView thread={thread} access={access} number={number} showLocate />
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="flex w-full gap-2.5 p-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <div className="relative">
            <Avatar name={thread.author.name} src={thread.author.image} size="sm" />
            <span className="absolute -right-1.5 -bottom-1 grid h-4 min-w-4 place-items-center rounded-full bg-surface-3 px-1 text-[9px] font-semibold tabular-nums text-fg-secondary ring-2 ring-surface-1">
              {number}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate text-[13px] font-medium text-fg">{thread.author.name}</span>
              <span className="shrink-0 text-[11px] text-fg-muted">
                {relativeTime(thread.lastActivityAt)}
              </span>
              <div className="flex-1" />
              {unread > 0 ? (
                <span
                  className="size-2 shrink-0 rounded-full bg-accent"
                  role="img"
                  aria-label={`${unread} unread`}
                />
              ) : null}
            </div>
            <p className="line-clamp-2 text-[13px] leading-5 text-fg-secondary">
              {thread.deleted ? (
                <span className="italic text-fg-muted">Deleted comment</span>
              ) : (
                thread.body
              )}
            </p>
            {replies > 0 || thread.resolved ? (
              <p className="mt-1 text-[11px] text-fg-muted">
                {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : ""}
                {replies > 0 && thread.resolved ? " · " : ""}
                {thread.resolved ? "Resolved" : ""}
              </p>
            ) : null}
          </div>
        </button>
      )}
    </li>
  );
}

/** Comments rail panel: filters, search, threads (expand inline, locate on canvas), new comment. */
export function CommentsPanel(_props: SlotProps) {
  const editor = useEditor();
  const { store } = useCollab();
  const access = useCommentAccess();
  const threads = useCollabStore((s) => s.threads);
  const error = useCollabStore((s) => s.commentsError);
  const filters = useCollabStore((s) => s.filters);
  const activeThread = useCollabStore((s) => s.activeThread);
  const lastSeenAt = useCollabStore((s) => s.lastSeenAt);
  const userId = useEditorStore((s) => s.user?.id ?? null);
  const pageId = useEditorStore((s) => s.pageId);
  const designId = useEditorStore((s) => s.designId);
  const tool = useEditorStore((s) => s.tool);

  const visible = useMemo(
    () => (threads ? filterThreads(threads, filters, { userId, pageId }) : []),
    [threads, filters, userId, pageId],
  );
  const numbers = useMemo(() => pinNumbers(threads ?? []), [threads]);

  // Opening the panel marks everything shown as seen (after a moment, so the unread dots register).
  // Server timestamps only: a local clock running ahead would hide comments posted in the meantime.
  useEffect(() => {
    if (!threads) return;
    const t = setTimeout(() => {
      const seen = Math.max(store.getState().lastSeenAt ?? 0, latestActivity(threads));
      writeLastSeen(userId ?? "anon", designId, seen);
      store.setState({ lastSeenAt: seen });
    }, 1500);
    return () => clearTimeout(t);
  }, [threads, userId, designId, store]);

  const setFilters = (patch: Partial<typeof filters>) =>
    store.setState((s) => ({ filters: { ...s.filters, ...patch } }));

  const startComment = () => {
    editor.setTool("comment");
    editor.notify({
      kind: "info",
      title: "Click anywhere on the canvas to comment",
      description: "Comments on a layer follow it when it moves.",
    });
  };

  const open = threads?.filter((t) => !t.resolved).length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-line-subtle px-3 pt-1 pb-3">
        <div className="flex items-center gap-2">
          <SegmentedControl
            size="sm"
            fullWidth
            options={STATUSES}
            value={filters.status}
            onValueChange={(status) => setFilters({ status })}
            aria-label="Thread status"
          />
        </div>
        <div className="flex gap-2">
          <Select
            size="sm"
            options={SCOPES}
            value={filters.scope}
            onValueChange={(scope) => setFilters({ scope })}
            aria-label="Show comments"
            className="w-[136px] shrink-0"
          />
          <Input
            size="sm"
            value={filters.query}
            onChange={(e) => setFilters({ query: e.target.value })}
            placeholder="Search"
            aria-label="Search comments"
            leading={<Search className="size-3.5" />}
            className="min-w-0 flex-1"
          />
        </div>
        {access.canComment ? (
          <Button
            variant={tool === "comment" ? "primary" : "secondary"}
            size="sm"
            leadingIcon={<MessageCirclePlus />}
            onClick={startComment}
          >
            {tool === "comment" ? "Click the canvas to place it" : "New comment"}
          </Button>
        ) : null}
        {access.featureAvailable === false ? (
          <div className="flex items-start gap-2 rounded-card border border-line-subtle bg-accent-wash p-2.5 text-xs text-fg-secondary">
            <ProBadge />
            <span>Upgrade this workspace to comment, mention teammates and resolve feedback.</span>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error ? (
          <EmptyState
            size="sm"
            icon={<MessagesSquare />}
            title={
              <>
                comments are <em className="text-accent">unavailable</em>
              </>
            }
            description={error.message}
          />
        ) : !threads ? (
          <div className="flex flex-col gap-3 p-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-2.5">
                <Skeleton className="size-6 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<MessagesSquare />}
            title={
              threads.length === 0 ? (
                <>
                  no comments <em className="text-accent">yet</em>
                </>
              ) : (
                <>
                  nothing <em className="text-accent">here</em>
                </>
              )
            }
            description={
              threads.length === 0
                ? access.canComment
                  ? "Press C and click the canvas to start a conversation."
                  : "Feedback from collaborators appears here."
                : open === 0 && filters.status === "open"
                  ? "Every thread is resolved."
                  : "No threads match these filters."
            }
          />
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Comment threads">
            {visible.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                number={numbers.get(t.id) ?? 0}
                unread={lastSeenAt === null ? 0 : unreadIn(t, userId, lastSeenAt)}
                expanded={activeThread === t.id}
                onToggle={() => {
                  if (activeThread === t.id) store.setState({ activeThread: null });
                  else focusThread(editor, t);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
