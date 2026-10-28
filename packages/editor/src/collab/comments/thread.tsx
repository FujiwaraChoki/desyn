"use client";

import {
  Avatar,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
  useConfirm,
} from "@desyn/ui";
import { CheckCircle2, Circle, Crosshair, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { CommentThread, CommentView, MentionableMember } from "../backend.ts";
import { useCollab } from "../state.ts";
import { type CommentAccess, useCommentAction } from "./access.ts";
import { Composer, useMentionable } from "./composer.tsx";
import { usePinFocus } from "./focus.ts";
import { segmentBody } from "./mentions.ts";
import { relativeTime } from "./model.ts";

function Body({ comment, people }: { comment: CommentView; people: MentionableMember[] }) {
  const mentioned = useMemo(
    () => people.filter((p) => comment.mentions.includes(p.id)),
    [people, comment.mentions],
  );
  if (comment.deleted) {
    return <p className="text-[13px] italic text-fg-muted">This comment was deleted.</p>;
  }
  return (
    <p className="text-[13px] leading-5 break-words whitespace-pre-wrap text-fg">
      {segmentBody(comment.body, mentioned).map((s, i) =>
        s.mention ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            key={i}
            className="rounded-[4px] bg-accent-tint px-0.5 font-medium text-accent"
          >
            {s.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

function CommentItem({
  comment,
  access,
  people,
  root,
}: {
  comment: CommentView;
  access: CommentAccess;
  people: MentionableMember[];
  root?: boolean;
}) {
  const { backend } = useCollab();
  const run = useCommentAction();
  const confirm = useConfirm();
  const userId = useEditorStore((s) => s.user?.id ?? null);
  const [editing, setEditing] = useState(false);
  const mine = userId !== null && comment.author.id === userId;
  const canDelete = !comment.deleted && (mine || access.canManage);
  const canEdit = !comment.deleted && mine && access.canComment;

  const remove = async () => {
    const ok = await confirm({
      title: root ? "Delete this thread?" : "Delete this reply?",
      description: root
        ? "The comment is removed for everyone. Replies stay visible."
        : "The reply is removed for everyone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (ok) await run("Couldn't delete the comment", () => backend.comments.remove(comment.id));
  };

  return (
    <div className="group/comment flex gap-2.5">
      <Avatar name={comment.author.name} src={comment.author.image} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[13px] font-medium text-fg">{comment.author.name}</span>
          <Tooltip content={new Date(comment.createdAt).toLocaleString()}>
            <span className="shrink-0 text-[11px] text-fg-muted">
              {relativeTime(comment.createdAt)}
              {comment.editedAt ? " · edited" : ""}
            </span>
          </Tooltip>
          <div className="flex-1" />
          {canEdit || canDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label="Comment actions"
                  tooltip={false}
                  size="sm"
                  variant="ghost"
                  className="size-6 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {canEdit ? (
                  <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                    Edit
                  </DropdownMenuItem>
                ) : null}
                {canDelete ? (
                  <DropdownMenuItem icon={<Trash2 />} destructive onSelect={() => void remove()}>
                    Delete
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {editing ? (
          <div className="mt-1">
            <Composer
              placeholder="Edit comment"
              submitLabel="Save"
              initial={comment.body}
              initialMentions={people.filter((p) => comment.mentions.includes(p.id))}
              autoFocus
              compact
              onCancel={() => setEditing(false)}
              onSubmit={async (body, mentions) => {
                const ok = await run("Couldn't save the comment", () =>
                  backend.comments.edit(comment.id, body, mentions),
                );
                if (ok) setEditing(false);
                return ok;
              }}
            />
          </div>
        ) : (
          <Body comment={comment} people={people} />
        )}
      </div>
    </div>
  );
}

export interface ThreadViewProps {
  thread: CommentThread;
  access: CommentAccess;
  number?: number;
  /** Show the "show on canvas" button (panel); pins already are on the canvas. */
  showLocate?: boolean;
  className?: string;
}

/** A thread: root comment, replies, resolve, reply box with mentions. */
export function ThreadView({ thread, access, number, showLocate, className }: ThreadViewProps) {
  const { backend } = useCollab();
  const editor = useEditor();
  const run = useCommentAction();
  const people = useMentionable();
  const focusPin = usePinFocus();
  const page = useEditorStore((s) =>
    thread.pageId ? (s.doc.design?.nodes[thread.pageId]?.name ?? null) : null,
  );
  const layer = useEditorStore((s) =>
    thread.nodeId ? (s.doc.design?.nodes[thread.nodeId]?.name ?? null) : null,
  );

  const toggleResolved = () =>
    void run(thread.resolved ? "Couldn't reopen the thread" : "Couldn't resolve the thread", () =>
      backend.comments.resolve(thread.id, !thread.resolved),
    ).then((ok) => {
      if (ok && !thread.resolved) {
        editor.telemetry("comment_resolved", {});
      }
    });

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
        {number !== undefined ? (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent-solid px-1 text-[10px] font-semibold text-accent-ink">
            {number}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          {page ?? "Page"}
          {layer || thread.nodeId ? (
            <>
              <span className="mx-1.5 opacity-60" aria-hidden>
                /
              </span>
              {layer ?? "deleted layer"}
            </>
          ) : null}
        </span>
        {showLocate ? (
          <IconButton
            label="Show on canvas"
            size="sm"
            variant="ghost"
            className="size-6"
            onClick={() => focusPin(thread)}
          >
            <Crosshair />
          </IconButton>
        ) : null}
        {access.canComment ? (
          <IconButton
            label={thread.resolved ? "Reopen thread" : "Resolve thread"}
            tooltip={thread.resolved ? "Reopen" : "Resolve"}
            size="sm"
            variant="ghost"
            className={cn("size-6", thread.resolved && "text-success")}
            onClick={toggleResolved}
          >
            {thread.resolved ? <CheckCircle2 /> : <Circle />}
          </IconButton>
        ) : null}
      </div>
      <CommentItem comment={thread} access={access} people={people} root />
      {thread.replies.map((r) => (
        <CommentItem key={r.id} comment={r} access={access} people={people} />
      ))}
      {thread.resolved && thread.resolvedBy ? (
        <p className="flex items-center gap-1.5 text-[11px] text-fg-muted">
          <CheckCircle2 className="size-3 text-success" />
          Resolved by {thread.resolvedBy.name}
          {thread.resolvedAt ? ` · ${relativeTime(thread.resolvedAt)}` : ""}
        </p>
      ) : null}
      {access.canComment ? (
        <Composer
          placeholder={thread.resolved ? "Reply to reopen" : "Reply"}
          submitLabel="Reply"
          compact
          onSubmit={(body, mentions) =>
            run("Couldn't send the reply", () => backend.comments.reply(thread.id, body, mentions))
          }
        />
      ) : null}
    </div>
  );
}
