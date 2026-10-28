import type { Transaction } from "@desyn/schema";
import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { SyncTransport } from "./transport.ts";
import {
  type CommitResult,
  encodeTx,
  type LoadPage,
  type ShareArg,
  type SinceResult,
} from "./wire.ts";

/*
 * Convex function references by name. The editor package does not depend on the generated API of the repo's
 * Convex app (it is consumed by the web app and could be by others), so references are created by name with
 * the argument / return types of the functions in convex/designs.
 */

type DesignId = string;

const refs = {
  load: makeFunctionReference<
    "query",
    { designId: DesignId; cursor?: string | null; share?: ShareArg },
    LoadPage
  >("designs/designs:load"),
  commit: makeFunctionReference<
    "mutation",
    { designId: DesignId; baseSeq?: number; tx: string; share?: ShareArg },
    CommitResult
  >("designs/designs:commit"),
  since: makeFunctionReference<
    "query",
    { designId: DesignId; seq: number; share?: ShareArg },
    SinceResult
  >("designs/designOps:since"),
  designUrls: makeFunctionReference<
    "query",
    { designId: DesignId; refs?: string[]; share?: ShareArg },
    { urls: Record<string, string>; expiresAt: number | null }
  >("assets/assets:designUrls"),
  requestUpload: makeFunctionReference<
    "mutation",
    {
      workspaceId: string;
      name: string;
      mime: string;
      bytes: number;
      sha256?: string;
      source?: "upload" | "brand";
    },
    UploadRequest
  >("assets/assets:requestUpload"),
  finalize: makeFunctionReference<
    "action",
    { assetId: string },
    { assetId: string; refId: string; deduplicated: boolean }
  >("assets/assets:finalize"),
  getAsset: makeFunctionReference<"query", { assetId: string }, AssetView>("assets/assets:get"),
  me: makeFunctionReference<"query", Record<string, never>, MeView | null>("accounts/profiles:me"),
  prefsGet: makeFunctionReference<"query", Record<string, never>, EditorPrefsView | null>(
    "editor/prefs:get",
  ),
  prefsSet: makeFunctionReference<
    "mutation",
    { shortcuts?: string; ui?: string },
    { updatedAt: number }
  >("editor/prefs:set"),
};

export interface UploadRequest {
  assetId: string;
  refId: string;
  deduplicated: boolean;
  upload: {
    url: string;
    method: "PUT";
    headers: Record<string, string>;
    expiresAt: number;
  } | null;
}

/** `assets.get` view (subset the editor reads). */
export interface AssetView {
  id: string;
  refId: string;
  kind: "image" | "svg" | "font" | "video" | "audio" | "lottie" | "data";
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hash: string | null;
  storageKey: string;
  source: string;
  family: string | null;
  weight: number | null;
  style: "normal" | "italic" | null;
  url: string | null;
}

/** `accounts/profiles:me` (subset). */
export interface MeView {
  userId: string;
  name: string;
  email: string;
  image: string | null;
}

/** `editor/prefs:get`: JSON strings so the shapes can evolve without schema changes. */
export interface EditorPrefsView {
  shortcuts: string | null;
  ui: string | null;
  updatedAt: number;
}

export interface AssetBackend {
  designUrls(
    refIds?: string[],
  ): Promise<{ urls: Record<string, string>; expiresAt: number | null }>;
  requestUpload(args: {
    workspaceId: string;
    name: string;
    mime: string;
    bytes: number;
    sha256?: string;
  }): Promise<UploadRequest>;
  finalize(assetId: string): Promise<{ assetId: string; refId: string; deduplicated: boolean }>;
  getAsset(assetId: string): Promise<AssetView>;
}

export interface PrefsBackend {
  get(): Promise<EditorPrefsView | null>;
  set(prefs: { shortcuts?: string; ui?: string }): Promise<void>;
}

export interface EditorBackend {
  sync: SyncTransport;
  assets: AssetBackend;
  /** Absent for anonymous share-link viewers. */
  prefs: PrefsBackend | null;
  me(): Promise<MeView | null>;
}

/** Everything the editor needs from Convex for one design. */
export function createConvexBackend(
  client: ConvexReactClient,
  designId: string,
  share?: ShareArg,
): EditorBackend {
  const shareArgs = share ? { share } : {};
  const sync: SyncTransport = {
    load: (cursor) => client.query(refs.load, { designId, cursor, ...shareArgs }),
    commit: ({ baseSeq, tx }: { baseSeq: number; tx: Transaction }) =>
      client.mutation(refs.commit, { designId, baseSeq, tx: encodeTx(tx), ...shareArgs }),
    watchSince(seq, onResult, onError) {
      const watch = client.watchQuery(refs.since, { designId, seq, ...shareArgs });
      let last: SinceResult | undefined;
      const read = () => {
        let value: SinceResult | undefined;
        try {
          value = watch.localQueryResult();
        } catch (e) {
          onError(e);
          return;
        }
        if (value !== undefined && value !== last) {
          last = value;
          onResult(value);
        }
      };
      const unsubscribe = watch.onUpdate(read);
      // A subscription that already exists only calls back on the next change: read the cached value now.
      read();
      return unsubscribe;
    },
    onConnectionChange(listener) {
      // Online = the browser has a network and the Convex socket is up. The socket reports "disconnected"
      // until its first connection, so before that only the browser signal counts. The browser's
      // `offline` event fires at once, while a dropped socket is noticed only after Convex's heartbeat.
      let socket = client.connectionState().isWebSocketConnected;
      let everConnected = client.connectionState().hasEverConnected;
      let network = typeof navigator === "undefined" || navigator.onLine !== false;
      let reported = network && (socket || !everConnected);
      const update = () => {
        const next = network && (socket || !everConnected);
        if (next === reported) return;
        reported = next;
        listener(next);
      };
      const offSocket = client.subscribeToConnectionState((state) => {
        if (state.hasEverConnected) everConnected = true;
        socket = state.isWebSocketConnected;
        update();
      });
      const onNetwork = () => {
        network = navigator.onLine !== false;
        update();
      };
      if (typeof window !== "undefined") {
        window.addEventListener("online", onNetwork);
        window.addEventListener("offline", onNetwork);
      }
      if (!reported) listener(false);
      return () => {
        offSocket();
        if (typeof window !== "undefined") {
          window.removeEventListener("online", onNetwork);
          window.removeEventListener("offline", onNetwork);
        }
      };
    },
  };
  const assets: AssetBackend = {
    designUrls: (refIds) =>
      client.query(refs.designUrls, {
        designId,
        ...(refIds ? { refs: refIds } : {}),
        ...shareArgs,
      }),
    requestUpload: (args) => client.mutation(refs.requestUpload, { ...args, source: "upload" }),
    finalize: (assetId) => client.action(refs.finalize, { assetId }),
    getAsset: (assetId) => client.query(refs.getAsset, { assetId }),
  };
  const prefs: PrefsBackend = {
    get: () => client.query(refs.prefsGet, {}),
    set: async (value) => {
      await client.mutation(refs.prefsSet, value);
    },
  };
  return {
    sync,
    assets,
    prefs,
    me: () => client.query(refs.me, {}),
  };
}
