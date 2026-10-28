"use client";

import { can, isPlanId } from "@desyn/schema";
import { useEditor, useEditorStore } from "../../context.tsx";
import { errorCode, errorMessage, useLive } from "../live.ts";
import { useCollab } from "../state.ts";

export interface CommentAccess {
  signedIn: boolean;
  /** May post, reply and resolve (comment / edit / manage permission while signed in). */
  canComment: boolean;
  /** May delete others' comments. */
  canManage: boolean;
  /** Workspace plan includes comments: true / false, or null when unknown (share-link visitors). */
  featureAvailable: boolean | null;
}

/** Who may do what with comments here (the server enforces the same rules). */
export function useCommentAccess(): CommentAccess {
  const { backend } = useCollab();
  const signedIn = useEditorStore((s) => s.user !== null);
  const permission = useEditorStore((s) => s.permission);
  const isShare = useEditorStore((s) => s.shareToken !== null);
  const workspaceId = useEditorStore((s) => s.doc.sync.header?.workspaceId ?? null);
  const ws = useLive(!isShare && workspaceId ? `ws:${workspaceId}` : null, () =>
    workspaceId ? backend.workspace(workspaceId) : null,
  );
  const plan = ws.data?.plan;
  const featureAvailable = plan && isPlanId(plan) ? can(plan, "collab.comments") : null;
  return {
    signedIn,
    canComment:
      signedIn && (permission === "comment" || permission === "edit" || permission === "manage"),
    canManage: permission === "manage",
    featureAvailable,
  };
}

/** Runs a comment action; failures become toasts. Resolves to true on success. */
export function useCommentAction() {
  const editor = useEditor();
  return async (title: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      const code = errorCode(e);
      editor.notify({
        kind: code === "FEATURE_UNAVAILABLE" ? "info" : "error",
        title: code === "FEATURE_UNAVAILABLE" ? "Comments are part of Desyn Pro" : title,
        description:
          code === "FEATURE_UNAVAILABLE"
            ? "Upgrade the workspace to discuss designs with comments and mentions."
            : errorMessage(e),
      });
      return false;
    }
  };
}
