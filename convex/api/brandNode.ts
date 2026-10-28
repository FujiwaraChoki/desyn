"use node";

import { type BrandKit, brandOps } from "@desyn/ai";
import type { AssetRef, Op, Transaction } from "@desyn/schema";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { principalValidator } from "../lib/api_principal";
import { assembleDesign, type CommitResult, type LoadPage } from "../lib/designs_wire";

// Agent API: apply a brand kit to a design with @desyn/ai `brandOps` (deterministic: maps colors, fonts and
// logos onto the kit without moving the layout and repairs text contrast), committed as one transaction.

/** AssetRef ids that ops point nodes at (`assetId` of updates and created nodes). */
function referencedAssets(ops: Op[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === "update" && typeof op.set?.assetId === "string") out.add(op.set.assetId);
    if (op.op === "create") {
      for (const node of op.nodes) {
        const assetId = (node as { assetId?: unknown }).assetId;
        if (typeof assetId === "string") out.add(assetId);
      }
    }
  }
  return out;
}

export interface ApplyBrandResult {
  brandKitId: string;
  recolored: number;
  fontsChanged: number;
  logos: string[];
  contrastFixes: string[];
  colorMap: Record<string, string>;
  commit: (CommitResult & { txId: string }) | null;
}

export const applyBrand = internalAction({
  args: {
    principal: principalValidator,
    designId: v.string(),
    txId: v.string(),
    brandKitId: v.optional(v.string()),
    pageIds: v.optional(v.array(v.string())),
    ids: v.optional(v.array(v.string())),
    colors: v.optional(v.boolean()),
    fonts: v.optional(v.boolean()),
    logo: v.optional(v.union(v.literal("replace"), v.literal("add"), v.literal("none"))),
  },
  handler: async (ctx, args): Promise<ApplyBrandResult> => {
    const brand: { brandKitId: string; kit: BrandKit; logoRefs: AssetRef[] } = await ctx.runQuery(
      internal.api.brand.forApply,
      {
        principal: args.principal,
        designId: args.designId,
        ...(args.brandKitId ? { brandKitId: args.brandKitId } : {}),
      },
    );
    const pages: LoadPage[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: LoadPage = await ctx.runQuery(internal.api.designs.loadPage, {
        principal: args.principal,
        designId: args.designId,
        cursor,
      });
      pages.push(page);
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const { design, seq } = assembleDesign(pages);
    const logoRefs = new Map<string, AssetRef>(brand.logoRefs.map((r) => [r.id, r]));
    // brandOps can only place logos the design references, so the kit's logos are visible to it.
    const withLogos = { ...design, assets: { ...Object.fromEntries(logoRefs), ...design.assets } };
    const report = brandOps(withLogos, brand.kit, {
      ...(args.pageIds ? { pageIds: args.pageIds } : {}),
      ...(args.ids ? { ids: args.ids } : {}),
      ...(args.colors !== undefined ? { colors: args.colors } : {}),
      ...(args.fonts !== undefined ? { fonts: args.fonts } : {}),
      logo: args.logo ?? "replace",
    });
    const summary = {
      brandKitId: brand.brandKitId,
      recolored: report.recolored,
      fontsChanged: report.fontsChanged,
      logos: report.logos,
      contrastFixes: report.contrastFixes,
      colorMap: report.colorMap,
    };
    const ops: Op[] = [];
    const newRefs: Record<string, AssetRef> = {};
    for (const id of referencedAssets(report.ops)) {
      const ref = logoRefs.get(id);
      if (ref && !design.assets[id]) newRefs[id] = ref;
    }
    if (Object.keys(newRefs).length > 0) ops.push({ op: "asset", set: newRefs });
    ops.push(...report.ops);
    if (design.brandKitId !== brand.brandKitId) {
      ops.push({ op: "doc", set: { brandKitId: brand.brandKitId } });
    }
    if (ops.length === 0) return { ...summary, commit: null };
    const tx: Transaction = {
      id: args.txId,
      label: `Apply brand kit: ${brand.kit.name}`.slice(0, 200),
      ops,
      source: "user",
      actor: { userId: args.principal.userId, agent: "api:apply-brand" },
      ts: Date.now(),
    };
    const commit: CommitResult & { txId: string } = await ctx.runMutation(
      internal.api.designs.commit,
      {
        principal: args.principal,
        designId: args.designId,
        baseSeq: seq,
        tx: JSON.stringify(tx),
      },
    );
    return { ...summary, commit };
  },
});
