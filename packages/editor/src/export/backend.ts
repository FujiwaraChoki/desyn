import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { type Live, liveQuery } from "../collab/live.ts";
import type { ShareArg } from "../sync/wire.ts";
import type { WireFormat } from "./formats.ts";
import type { ServerExportArgs } from "./options.ts";

/** `exports.status` / `exports.list` item. */
export interface ExportJob {
  id: string;
  designId: string;
  format: WireFormat;
  pages: "all" | string[];
  scale: number;
  status: "queued" | "rendering" | "ready" | "failed" | "expired";
  files: {
    pageId: string | null;
    fileName: string;
    contentType: string;
    bytes: number;
    /** Null when the storage cannot sign a URL right now. */
    url: string | null;
  }[];
  error: string | null;
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  expiresAt: number | null;
}

/** `exports.request` arguments (without `designId` / `share`, which the backend adds). */
export type ExportRequestArgs = ServerExportArgs;

/** The signed-in user's plan features (`profiles.me`), null when signed out. */
export interface ExportAccount {
  userId: string;
  plan: string;
  edition: "hosted" | "selfhost";
  features: Record<string, boolean>;
}

export interface ExportBackend {
  request(args: ExportRequestArgs): Promise<string>;
  status(exportId: string): Live<ExportJob>;
  recent(): Live<ExportJob[]>;
  account(): Live<ExportAccount | null>;
  /** Deployment edition (self-hosted deployments unlock every format, also for visitors). */
  edition(): Live<{ edition: "hosted" | "selfhost" }>;
}

type Args = Record<string, unknown>;

const refs = {
  request: makeFunctionReference<"mutation", Args, string>("exports/exports:request"),
  status: makeFunctionReference<"query", Args, ExportJob>("exports/exports:status"),
  list: makeFunctionReference<"query", Args, ExportJob[]>("exports/exports:list"),
  me: makeFunctionReference<"query", Args, ExportAccount | null>("accounts/profiles:me"),
  config: makeFunctionReference<"query", Args, { edition: "hosted" | "selfhost" }>(
    "accounts/config:get",
  ),
};

export function createConvexExportBackend(
  client: ConvexReactClient,
  designId: string,
  share?: ShareArg,
): ExportBackend {
  return {
    request: (args) =>
      client.mutation(refs.request, { designId, ...args, ...(share ? { share } : {}) }),
    status: (exportId) => liveQuery(client, refs.status, { exportId }),
    recent: () => liveQuery(client, refs.list, { designId }),
    account: () => liveQuery(client, refs.me, {}),
    edition: () => liveQuery(client, refs.config, {}),
  };
}
