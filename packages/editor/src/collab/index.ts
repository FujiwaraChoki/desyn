import { approxBounds, unionRects } from "@desyn/doc-ops";
import { EyeOff, MessageSquarePlus, MessagesSquare } from "lucide-react";
import type { AnyCommand } from "../commands/registry.ts";
import type { EditorController } from "../controller.ts";
import { defineExtension, type EditorExtension } from "../shell/extensions.ts";
import { type CollabBackend, createConvexCollabBackend } from "./backend.ts";
import { anchorAt } from "./comments/anchor.ts";
import { CommentsButton } from "./comments/badge.tsx";
import { CommentsPanel } from "./comments/panel.tsx";
import { CommentPins } from "./comments/pins.tsx";
import { PresenceAvatars } from "./presence/avatars.tsx";
import { CollabController } from "./presence/controller.tsx";
import { PresenceOverlay } from "./presence/cursors.tsx";
import { ShareDialog } from "./share/dialog.tsx";
import { attachCollab, collabOf, detachCollab } from "./state.ts";
import { AutosaveController } from "./versions/autosave.tsx";
import { VersionsPanel } from "./versions/panel.tsx";
import { VersionPreviewOverlay } from "./versions/preview.tsx";
import { SaveVersionDialog } from "./versions/save-dialog.tsx";

export interface CollabExtensionOptions {
  /** Backend for collaboration (default: the editor's Convex client; none = the extension stays off). */
  backend?: (editor: EditorController) => CollabBackend | null;
}

function defaultBackend(editor: EditorController): CollabBackend | null {
  if (!editor.convex) return null;
  return createConvexCollabBackend(editor.convex, editor.getState().designId, editor.share);
}

function collabCommands(): AnyCommand[] {
  return [
    {
      id: "collab.stopFollowing",
      label: "Stop following",
      category: "collab",
      icon: EyeOff,
      when: (_ctx, editor) => !!collabOf(editor)?.store.getState().following,
      run: (_a, { editor }) => collabOf(editor)?.store.setState({ following: null }),
    },
    {
      id: "comments.onSelection",
      label: "Comment on selection",
      category: "collab",
      icon: MessageSquarePlus,
      keywords: ["feedback", "note", "discuss"],
      when: (ctx) =>
        ctx.canComment === true && ctx.signedIn === true && ctx.selectionHasNodes === true,
      run: (_a, { editor }) => {
        const services = collabOf(editor);
        const design = editor.design;
        const pageId = editor.getState().pageId;
        const ids = editor.getState().selection;
        if (!services || !design || !pageId || ids.length === 0) return;
        const b = unionRects(
          ids.flatMap((id) => {
            const r = approxBounds(design, id, "page");
            return r ? [r] : [];
          }),
        );
        if (!b) return;
        // Top-right corner of the selection, attached to the first selected layer.
        const point = { x: b.x + b.width, y: b.y };
        const anchor = anchorAt(design, pageId, point, ids[0] ?? null);
        services.store.setState({
          draft: { pageId, x: point.x, y: point.y, nodeId: anchor.nodeId },
          activeThread: null,
        });
      },
    },
  ];
}

/**
 * Collaboration: presence (cursors, selections, avatars, follow mode), comments (pins, threads panel,
 * mentions, resolve, unread badge), share dialog (members, links, embed) and version history (named +
 * autosaved versions, read-only preview on the canvas, restore).
 */
export function createCollabExtension(options: CollabExtensionOptions = {}): EditorExtension {
  return defineExtension({
    id: "collab",
    setup(api) {
      const backend = (options.backend ?? defaultBackend)(api.editor);
      if (!backend) return;
      attachCollab(api.editor, backend);
      api.onDispose(() => detachCollab(api.editor));

      api.registerSlot("root", { id: "collab.controller", component: CollabController });
      api.registerSlot("root", {
        id: "collab.autosave",
        component: AutosaveController,
        modes: ["edit"],
      });
      api.registerSlot("topbar.presence", { id: "collab.avatars", component: PresenceAvatars });
      api.registerSlot("topbar.actions", {
        id: "collab.comments",
        component: CommentsButton,
        order: 10,
      });
      api.registerSlot("canvas.overlay", {
        id: "collab.presence",
        component: PresenceOverlay,
        order: 50,
      });
      api.registerSlot("canvas.overlay", {
        id: "collab.pins",
        component: CommentPins,
        order: 60,
      });
      api.registerSlot("canvas.overlay", {
        id: "collab.versionPreview",
        component: VersionPreviewOverlay,
        order: 90,
      });
      api.registerRailPanel({
        id: "comments",
        label: "Comments",
        icon: MessagesSquare,
        order: 85,
        component: CommentsPanel,
      });
      api.registerModal({ id: "share", component: ShareDialog });
      api.registerModal({ id: "versions", component: VersionsPanel });
      api.registerModal({ id: "save-version", component: SaveVersionDialog });
      api.registerCommands(collabCommands());
      api.registerContextMenu([{ command: "comments.onSelection", target: "selection", order: 6 }]);
    },
  });
}

export const collabExtension = createCollabExtension();

export type { CollabBackend } from "./backend.ts";
export { createConvexCollabBackend } from "./backend.ts";
export { anchorAt, resolvePin } from "./comments/anchor.ts";
