import type { ConvexReactClient } from "convex/react";
import { type FunctionReference, makeFunctionReference } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { useEditor } from "../context.tsx";
import type { AssetView } from "../sync/convex-transport.ts";

/*
 * Backend functions the panels read and call. Referenced by name (like src/sync/convex-transport.ts) so the
 * editor package does not depend on the Convex app's generated API; argument and result types follow
 * the functions in convex/. `editor.convex` is null in tests and other hosts: every hook then reports "unavailable"
 * and the panels show a calm empty state instead of failing.
 */

type Paginated<T> = { page: T[]; isDone: boolean; continueCursor: string };
type PaginationOpts = { numItems: number; cursor: string | null };

export interface TemplateView {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: string;
  category: string;
  categories: string[];
  tags: string[];
  premium: boolean;
  pageCount: number;
  width: number;
  height: number;
  thumbnails: { url: string | null; width: number; height: number }[];
  favorite: boolean;
}

export interface BrandColor {
  id: string;
  name: string;
  value: string;
  role?: string;
}

export interface BrandFont {
  family: string;
  weight: number;
  style: "normal" | "italic";
  assetId?: string;
  fallback?: string;
  url: string | null;
  refId: string | null;
}

export interface BrandLogo {
  id: string;
  assetId: string;
  name: string;
  variant: string;
  refId: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  url: string | null;
}

export interface BrandKitView {
  id: string;
  workspaceId: string;
  name: string;
  logos: BrandLogo[];
  colors: BrandColor[];
  fonts: { heading?: BrandFont; body?: BrandFont; accent?: BrandFont };
  voice: { tone: string; description: string; keywords: string[]; avoid: string[] } | null;
  rules: string[];
  isDefault: boolean;
}

/** `accounts/profiles:me` subset the panels use for plan gating. */
export interface MeFeatures {
  userId: string;
  plan: string;
  planName: string;
  features: Record<string, boolean>;
}

export interface AssetFolderView {
  id: string;
  name: string;
  count: number;
  createdAt: number;
}

/** A result of `stock/photos:search` (attribution fields as each source requires). */
export interface StockPhoto {
  id: string;
  provider: "unsplash" | "pexels";
  description: string;
  width: number;
  height: number;
  thumbUrl: string;
  url: string;
  color?: string;
  author: string;
  authorUrl: string;
  sourceUrl: string;
  license: string;
  downloadLocation?: string;
}

export interface StockUseResult {
  asset: AssetView;
}

export const refs = {
  me: makeFunctionReference<"query", Record<string, never>, MeFeatures | null>(
    "accounts/profiles:me",
  ),
  templatesList: makeFunctionReference<
    "query",
    {
      category?: string;
      kind?: string;
      sort?: "popular" | "new";
      paginationOpts: PaginationOpts;
    },
    Paginated<TemplateView>
  >("templates/templates:list"),
  templatesSearch: makeFunctionReference<
    "query",
    { query: string; kind?: string; category?: string; paginationOpts: PaginationOpts },
    Paginated<TemplateView>
  >("templates/templates:search"),
  templatesCategories: makeFunctionReference<
    "query",
    Record<string, never>,
    { category: string; count: number }[]
  >("templates/templates:categories"),
  templatesGetDesign: makeFunctionReference<"query", { templateId: string }, { design: string }>(
    "templates/templates:getDesign",
  ),
  templatesFavorite: makeFunctionReference<
    "mutation",
    { templateId: string; favorite: boolean },
    unknown
  >("templates/templates:favorite"),
  brandList: makeFunctionReference<"query", { workspaceId: string }, BrandKitView[]>(
    "brand/brandKits:list",
  ),
  assetsList: makeFunctionReference<
    "query",
    { workspaceId: string; kind?: string; search?: string; paginationOpts: PaginationOpts },
    Paginated<AssetView & { createdAt?: number }>
  >("assets/assets:list"),
  assetsGet: makeFunctionReference<"query", { assetId: string }, AssetView>("assets/assets:get"),
  assetsRename: makeFunctionReference<"mutation", { assetId: string; name: string }, null>(
    "assets/assets:rename",
  ),
  assetsDelete: makeFunctionReference<"mutation", { assetId: string }, null>(
    "assets/assets:delete",
  ),
  foldersList: makeFunctionReference<"query", { workspaceId: string }, AssetFolderView[]>(
    "panels/assetFolders:list",
  ),
  foldersCreate: makeFunctionReference<"mutation", { workspaceId: string; name: string }, string>(
    "panels/assetFolders:create",
  ),
  foldersRename: makeFunctionReference<"mutation", { folderId: string; name: string }, null>(
    "panels/assetFolders:rename",
  ),
  foldersRemove: makeFunctionReference<"mutation", { folderId: string }, null>(
    "panels/assetFolders:remove",
  ),
  foldersAssets: makeFunctionReference<
    "query",
    { folderId: string; paginationOpts: PaginationOpts },
    Paginated<AssetView>
  >("panels/assetFolders:assets"),
  foldersMove: makeFunctionReference<
    "mutation",
    { workspaceId: string; assetIds: string[]; folderId: string | null },
    null
  >("panels/assetFolders:move"),
  stockSearch: makeFunctionReference<
    "action",
    {
      query: string;
      page?: number;
      count?: number;
      orientation?: "landscape" | "portrait" | "square";
      color?: string;
    },
    { photos: StockPhoto[]; hasMore: boolean }
  >("stock/photos:search"),
  stockUse: makeFunctionReference<
    "action",
    {
      workspaceId: string;
      photo: {
        id: string;
        url: string;
        description?: string;
        author: string;
        authorUrl?: string;
        sourceUrl?: string;
        downloadLocation?: string;
      };
    },
    StockUseResult
  >("panels/stock:use"),
};

export type QueryState<T> =
  | { status: "unavailable"; data: undefined; error: undefined }
  | { status: "loading"; data: T | undefined; error: undefined }
  | { status: "ready"; data: T; error: undefined }
  | { status: "error"; data: T | undefined; error: Error };

const UNAVAILABLE = { status: "unavailable", data: undefined, error: undefined } as const;

/** Readable message from a Convex error (`ConvexError<{ code, message }>` or a plain Error). */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as { data: unknown }).data;
    if (data && typeof data === "object" && "message" in data)
      return String((data as { message: unknown }).message);
    if (typeof data === "string") return data;
  }
  if (e instanceof Error) return e.message.replace(/^\[CONVEX [^\]]+\]\s*/, "");
  return String(e);
}

/** Error code of a Convex error (`FEATURE_UNAVAILABLE`, `NOT_CONFIGURED`...), if any. */
export function errorCode(e: unknown): string | null {
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as { data: unknown }).data;
    if (data && typeof data === "object" && "code" in data)
      return String((data as { code: unknown }).code);
  }
  return null;
}

function watch<T>(
  convex: ConvexReactClient,
  ref: FunctionReference<"query">,
  args: Record<string, unknown>,
  onChange: (state: QueryState<T>) => void,
): () => void {
  const w = convex.watchQuery(ref, args as never);
  let last: unknown;
  const read = () => {
    try {
      const value = w.localQueryResult() as T | undefined;
      if (value !== undefined && value !== last) {
        last = value;
        onChange({ status: "ready", data: value, error: undefined });
      }
    } catch (e) {
      onChange({
        status: "error",
        data: last as T | undefined,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  };
  const off = w.onUpdate(read);
  read();
  return off;
}

/**
 * Reactive Convex query through `editor.convex`. Pass `"skip"` to wait (missing workspace, empty search).
 * Returns "unavailable" without a Convex client (tests, other hosts).
 */
export function useBackendQuery<Args extends Record<string, unknown>, T>(
  ref: FunctionReference<"query", "public", Args, T>,
  args: NoInfer<Args> | "skip",
): QueryState<T> {
  const editor = useEditor();
  const convex = editor.convex;
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  const [state, setState] = useState<QueryState<T>>(
    convex ? { status: "loading", data: undefined, error: undefined } : UNAVAILABLE,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `args` (a fresh object per render)
  useEffect(() => {
    if (!convex) {
      setState(UNAVAILABLE);
      return;
    }
    if (key === "skip") {
      setState({ status: "loading", data: undefined, error: undefined });
      return;
    }
    setState((s) => ({ status: "loading", data: s.data, error: undefined }));
    return watch<T>(convex, ref, args as Record<string, unknown>, setState);
  }, [convex, key, ref]);
  return state;
}

const FIRST_PAGE: (string | null)[] = [null];
const NO_PAGES: Record<number, never> = {};

export interface PaginatedState<T> {
  status: "unavailable" | "loading" | "ready" | "error";
  items: T[];
  error: Error | undefined;
  /** More pages exist on the server. */
  canLoadMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * Reactive paginated Convex query (each loaded page stays subscribed, like convex/react's usePaginatedQuery).
 * Changing `args` starts over from the first page.
 */
export function usePaginatedBackendQuery<FullArgs extends { paginationOpts: PaginationOpts }, T>(
  ref: FunctionReference<"query", "public", FullArgs, Paginated<T>>,
  args: NoInfer<Omit<FullArgs, "paginationOpts">> | "skip",
  pageSize = 24,
): PaginatedState<T> {
  const editor = useEditor();
  const convex = editor.convex;
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  // Cursors and pages belong to one query (`key`): a new query starts from the first page in the same
  // render, so a cursor of the previous query is never sent with the new arguments.
  const [cursorState, setCursorState] = useState<{ key: string; cursors: (string | null)[] }>(
    () => ({ key, cursors: FIRST_PAGE }),
  );
  const cursors = cursorState.key === key ? cursorState.cursors : FIRST_PAGE;
  const [pageState, setPageState] = useState<{
    key: string;
    pages: Record<number, QueryState<Paginated<T>>>;
  }>(() => ({ key, pages: {} }));
  const pages = pageState.key === key ? pageState.pages : NO_PAGES;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `args`
  useEffect(() => {
    if (!convex || key === "skip") return;
    const offs = cursors.map((cursor, i) =>
      watch<Paginated<T>>(
        convex,
        ref as unknown as FunctionReference<"query">,
        { ...(args as Record<string, unknown>), paginationOpts: { numItems: pageSize, cursor } },
        (state) =>
          setPageState((s) => ({
            key,
            pages: { ...(s.key === key ? s.pages : {}), [i]: state },
          })),
      ),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [convex, key, cursors, ref, pageSize]);

  return useMemo(() => {
    if (!convex) {
      return {
        status: "unavailable",
        items: [],
        error: undefined,
        canLoadMore: false,
        loadingMore: false,
        loadMore: () => {},
      };
    }
    const items: T[] = [];
    let error: Error | undefined;
    let lastLoaded: Paginated<T> | undefined;
    let loadedCount = 0;
    for (let i = 0; i < cursors.length; i++) {
      const p = pages[i];
      if (p?.status === "error") error = p.error;
      if (p?.data) {
        items.push(...p.data.page);
        lastLoaded = p.data;
        loadedCount++;
      }
    }
    const first = pages[0];
    const status: PaginatedState<T>["status"] =
      key === "skip"
        ? "loading"
        : first?.status === "ready" || first?.data
          ? error
            ? "error"
            : "ready"
          : first?.status === "error"
            ? "error"
            : "loading";
    const allLoaded = loadedCount === cursors.length;
    const canLoadMore = !!lastLoaded && allLoaded && !lastLoaded.isDone;
    return {
      status,
      items,
      error,
      canLoadMore,
      loadingMore: !allLoaded && cursors.length > 1,
      loadMore: () => {
        if (!canLoadMore || !lastLoaded) return;
        const next = lastLoaded.continueCursor;
        setCursorState((s) => {
          const current = s.key === key ? s.cursors : FIRST_PAGE;
          return { key, cursors: current.includes(next) ? current : [...current, next] };
        });
      },
    };
  }, [convex, cursors, pages, key]);
}

/** Plan features of the signed-in user (null while unknown or without a backend: nothing is gated then). */
export function usePlanFeatures(): Record<string, boolean> | null {
  const me = useBackendQuery(refs.me, {});
  return me.data?.features ?? null;
}

/** The workspace of the open design (uploads, brand kits). */
export function useWorkspaceId(): string | null {
  const editor = useEditor();
  // The header arrives with the first load page and does not change afterwards.
  const [id, setId] = useState<string | null>(() => editor.sync.loadHeader?.workspaceId ?? null);
  useEffect(() => {
    const read = () => setId(editor.sync.loadHeader?.workspaceId ?? null);
    read();
    return editor.sync.on("status", read);
  }, [editor]);
  return id;
}
