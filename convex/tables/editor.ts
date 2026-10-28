import { defineTable } from "convex/server";
import { v } from "convex/values";

// Editor preferences per user. Owned by the editor agent (packages/editor).

export const editorTables = {
  /**
   * Panel layout and custom keyboard shortcuts of the editor, synced across devices. Values are JSON strings
   * (validated and size-capped in convex/editor/prefs.ts) so the client can evolve their shape freely.
   */
  editorPrefs: defineTable({
    userId: v.string(),
    /** JSON object: command id -> key combos. */
    shortcuts: v.optional(v.string()),
    /** JSON object: panel layout (flyout, widths, inspector tab, toggles). */
    ui: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),
};
