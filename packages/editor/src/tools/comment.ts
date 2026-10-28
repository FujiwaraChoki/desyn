import type { CanvasController } from "../canvas/controller.ts";
import { CURSORS } from "../canvas/cursors.ts";
import type { CanvasPointer, Tool } from "./types.ts";

/**
 * Comment tool: click to drop a comment pin. When a collaboration extension registers the
 * `comments.compose` command it gets `{ pageId, nodeId, x, y, screen }` (page coordinates, the top-level layer
 * under the pin) and owns the thread UI; otherwise the canvas opens its own composer, which posts through
 * the Convex `collab/comments:create` function.
 */
export const COMPOSE_COMMAND = "comments.compose";

export const commentTool: Tool = {
  id: "comment",

  cursor(): string {
    return CURSORS.comment;
  },

  async down(c: CanvasController, e: CanvasPointer): Promise<null> {
    const pageId = c.pageId;
    const state = c.state;
    if (!pageId) return null;
    if (!state.user) {
      c.editor.notify({ kind: "info", title: "Sign in to comment on this design." });
      return null;
    }
    if (
      state.permission !== "comment" &&
      state.permission !== "edit" &&
      state.permission !== "manage"
    ) {
      c.editor.notify({ kind: "info", title: "You can view this design but not comment on it." });
      return null;
    }
    const path = await c.hitPath(e.screen);
    const nodeId = path[0] ?? null;
    const args = {
      pageId,
      nodeId,
      x: Math.round(e.page.x),
      y: Math.round(e.page.y),
      screen: e.screen,
    };
    if (c.editor.commands.get(COMPOSE_COMMAND)) {
      await c.editor.commands.run(COMPOSE_COMMAND, args, "api");
      return null;
    }
    c.setUi({ composer: { screen: e.screen, page: e.page, pageId, nodeId } });
    return null;
  },
};
