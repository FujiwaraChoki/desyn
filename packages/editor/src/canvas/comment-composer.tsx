"use client";

import { Button, Textarea } from "@desyn/ui";
import { makeFunctionReference } from "convex/server";
import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { anchorAt } from "../collab/comments/anchor.ts";
import { useEditorStore } from "../context.tsx";
import type { ShareArg } from "../sync/wire.ts";
import type { CanvasController } from "./controller.ts";

/**
 * Inline composer for the comment tool when no collaboration extension handles `comments.compose`: a pin at
 * the clicked point and a small card that posts the thread through `collab/comments:create`.
 */

const createComment = makeFunctionReference<
  "mutation",
  {
    designId: string;
    body: string;
    nodeId?: string;
    pageId?: string;
    x?: number;
    y?: number;
    share?: ShareArg;
  },
  string
>("collab/comments:create");

export function CommentComposer({ controller }: { controller: CanvasController }) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi, controller.getUi);
  useEditorStore((s) => s.viewport);
  const composer = ui.composer;
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (composer) {
      setBody("");
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [composer]);

  if (!composer) return null;
  const editor = controller.editor;
  const at = controller.toScreen(composer.page);
  const close = () => controller.setUi({ composer: null });
  const post = async () => {
    const text = body.trim();
    if (!text || busy) return;
    const convex = editor.convex;
    if (!convex) {
      editor.notify({ kind: "error", title: "Comments need a connection to Desyn." });
      return;
    }
    const design = editor.design;
    if (!design) return;
    // Shared pin contract (src/collab/comments/anchor.ts): page coordinates, or the layer's own box
    // coordinates when the pin is anchored to a layer, so it rides along when the layer moves.
    const anchor = anchorAt(design, composer.pageId, composer.page, composer.nodeId);
    setBusy(true);
    try {
      await convex.mutation(createComment, {
        designId: editor.getState().designId,
        body: text,
        pageId: anchor.pageId,
        x: anchor.x,
        y: anchor.y,
        ...(anchor.nodeId ? { nodeId: anchor.nodeId } : {}),
        ...(editor.share ? { share: editor.share } : {}),
      });
      editor.telemetry("comment_created", { anchored: !!anchor.nodeId });
      editor.notify({ kind: "success", title: "Comment added" });
      close();
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't add the comment",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-canvas-chrome=""
      className="pointer-events-auto absolute z-[4]"
      style={{ left: Math.round(at.x), top: Math.round(at.y) }}
    >
      <div className="-translate-y-full absolute left-0 grid size-8 place-items-center rounded-full rounded-bl-none bg-accent-solid text-accent-ink shadow-popover">
        <MessageCircle className="size-4" />
      </div>
      <form
        className="absolute top-2 left-3 w-72 animate-fade-up rounded-card border border-line-subtle bg-glass p-3 shadow-dialog backdrop-blur-[20px] backdrop-saturate-[1.2]"
        onSubmit={(e) => {
          e.preventDefault();
          void post();
        }}
      >
        <Textarea
          ref={ref}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment"
          aria-label="Comment"
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void post();
            }
          }}
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!body.trim()}>
            Comment
          </Button>
        </div>
      </form>
    </div>
  );
}
