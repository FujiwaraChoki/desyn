import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { DesignPermission } from "./designs_access";
import { blobUrl } from "./designs_blob";

// Client-facing shapes of design rows.

export interface DesignSummary {
  id: Id<"designs">;
  key: string;
  name: string;
  kind: string;
  workspaceId: Id<"workspaces">;
  folderId: Id<"folders"> | null;
  ownerId: string;
  state: Doc<"designs">["state"];
  pageCount: number;
  width: number;
  height: number;
  thumbnailUrl: string | null;
  templateId: Id<"templates"> | null;
  shareCount: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  permission: DesignPermission | null;
}

export async function designSummary(
  ctx: QueryCtx | MutationCtx,
  d: Doc<"designs">,
  permission: DesignPermission | null,
): Promise<DesignSummary> {
  return {
    id: d._id,
    key: d.key,
    name: d.name,
    kind: d.kind,
    workspaceId: d.workspaceId,
    folderId: d.folderId ?? null,
    ownerId: d.ownerId,
    state: d.state,
    pageCount: d.pageCount,
    width: d.width,
    height: d.height,
    thumbnailUrl: d.thumbnailKey ? await blobUrl(ctx, d.thumbnailKey) : null,
    templateId: d.templateId ?? null,
    shareCount: d.shareCount,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    archivedAt: d.archivedAt ?? null,
    deletedAt: d.deletedAt ?? null,
    permission,
  };
}
