import { defineTable } from "convex/server";
import { v } from "convex/values";

// Editor panels (packages/editor/src/panels): folders that organize a workspace's upload library. Assets stay
// in `assets`; a folder only groups them (an asset is in at most one folder). Owned by the panels agent.

export const panelsTables = {
  assetFolders: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_name", ["workspaceId", "name"]),
  assetFolderItems: defineTable({
    workspaceId: v.id("workspaces"),
    folderId: v.id("assetFolders"),
    assetId: v.id("assets"),
    addedAt: v.number(),
  })
    .index("by_folder_added", ["folderId", "addedAt"])
    .index("by_asset", ["assetId"])
    .index("by_workspace", ["workspaceId"]),
};
