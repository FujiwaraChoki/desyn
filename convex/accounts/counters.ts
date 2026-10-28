import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Named system counters (e.g. "users") so the admin console avoids full table scans. */
export async function bumpCounter(ctx: MutationCtx, key: string, delta: number): Promise<void> {
  const row = await ctx.db
    .query("systemCounters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  const now = Date.now();
  if (row)
    await ctx.db.patch("systemCounters", row._id, {
      value: Math.max(0, row.value + delta),
      updatedAt: now,
    });
  else await ctx.db.insert("systemCounters", { key, value: Math.max(0, delta), updatedAt: now });
}

export async function readCounter(ctx: QueryCtx | MutationCtx, key: string): Promise<number> {
  const row = await ctx.db
    .query("systemCounters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row?.value ?? 0;
}
