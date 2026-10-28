import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import { errors, getUser, requireUser } from "../lib";

// Editor preferences (packages/editor store/prefs.ts): panel layout and custom shortcuts, per user.

/** Each value is a JSON object string; keep the row small (it is read on every editor open). */
const MAX_BYTES = 16_000;
/**
 * A key combo as the editor records it: modifiers, then one printable ASCII key or a lowercase key name
 * (`mod+shift+k`, `mod+\\`, `alt+<`, `pageup`, `f12`). Kept in sync with `KEY_COMBO` in
 * packages/editor/src/store/prefs.ts.
 */
const COMBO = /^(?=.{1,48}$)((mod|ctrl|meta|alt|shift)\+)*([\x21-\x7e]|[a-z][a-z0-9]{1,23})$/;

function checkJsonObject(value: string, field: string): Record<string, unknown> {
  if (value.length > MAX_BYTES) throw errors.invalid(`${field} is too large.`, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw errors.invalid(`${field} is not valid JSON.`, field);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw errors.invalid(`${field} must be a JSON object.`, field);
  }
  return parsed as Record<string, unknown>;
}

function checkShortcuts(value: string): void {
  const map = checkJsonObject(value, "shortcuts");
  for (const [id, keys] of Object.entries(map)) {
    if (id.length > 96 || !/^[A-Za-z0-9_.-]+$/.test(id)) {
      throw errors.invalid("Unknown command id in shortcuts.", "shortcuts");
    }
    if (
      !Array.isArray(keys) ||
      keys.length > 4 ||
      !keys.every((k) => typeof k === "string" && COMBO.test(k))
    ) {
      throw errors.invalid(`Invalid key binding for ${id}.`, "shortcuts");
    }
  }
}

/** The signed-in user's editor preferences (null when signed out or never saved). */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUser(ctx);
    if (!user) return null;
    const row = await ctx.db
      .query("editorPrefs")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      .unique();
    if (!row) return null;
    return { shortcuts: row.shortcuts ?? null, ui: row.ui ?? null, updatedAt: row.updatedAt };
  },
});

/** Saves editor preferences (fields not given stay as they are). */
export const set = mutation({
  args: { shortcuts: v.optional(v.string()), ui: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.shortcuts !== undefined) checkShortcuts(args.shortcuts);
    if (args.ui !== undefined) checkJsonObject(args.ui, "ui");
    const now = Date.now();
    const row = await ctx.db
      .query("editorPrefs")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      .unique();
    const patch = {
      ...(args.shortcuts !== undefined ? { shortcuts: args.shortcuts } : {}),
      ...(args.ui !== undefined ? { ui: args.ui } : {}),
      updatedAt: now,
    };
    if (row) await ctx.db.patch("editorPrefs", row._id, patch);
    else await ctx.db.insert("editorPrefs", { userId: user.userId, ...patch });
    return { updatedAt: now };
  },
});

/** Account deletion hook (accounts/cleanup.ts `userCleanupHooks`). */
export const userCleanup = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("editorPrefs")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .take(100);
    for (const row of rows) await ctx.db.delete("editorPrefs", row._id);
    return { done: rows.length === 0 };
  },
});
