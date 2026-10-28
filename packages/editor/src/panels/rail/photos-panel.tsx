"use client";

import { createImage } from "@desyn/schema";
import { cn } from "@desyn/ui";
import { Camera, ImageOff, KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import { assetRefFromView } from "../../sync/assets.ts";
import { errorCode, errorMessage, refs, type StockPhoto, useWorkspaceId } from "../backend.ts";
import { fitToPage, insertSubtree } from "../lib/insert.ts";
import {
  ChipRow,
  LoadMore,
  PanelBody,
  PanelEmpty,
  SearchField,
  TileSkeletons,
  useDebounced,
} from "../ui/primitives.tsx";

/**
 * Photos: Unsplash and Pexels through the backend (keys stay on the server). Picking a photo copies it into
 * the workspace library with its attribution (and triggers the provider's download tracking), then places
 * it. Without keys the panel explains how to enable stock photos instead of showing an empty grid.
 */

const SUGGESTIONS = [
  "nature",
  "city",
  "abstract",
  "people",
  "texture",
  "food",
  "travel",
  "architecture",
  "minimal",
];
/** Color filters (hex: what `stock/photos:search` forwards to the sources). */
const COLORS = [
  { value: "", label: "Any color" },
  { value: "ff8a1f", label: "Orange" },
  { value: "ffd23f", label: "Yellow" },
  { value: "e5484d", label: "Red" },
  { value: "30a46c", label: "Green" },
  { value: "3e7bfa", label: "Blue" },
  { value: "111111", label: "Dark" },
];

type Orientation = "any" | "landscape" | "portrait" | "square";

export function PhotosPanel() {
  const editor = useEditor();
  const workspaceId = useWorkspaceId();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [query, setQuery] = useState("");
  const [suggestion, setSuggestion] = useState(SUGGESTIONS[0] as string);
  const [orientation, setOrientation] = useState<Orientation>("any");
  const [color, setColor] = useState("");
  const q = useDebounced(query.trim(), 400) || suggestion;
  const [results, setResults] = useState<{
    key: string;
    photos: StockPhoto[];
    page: number;
    loading: boolean;
    hasMore: boolean;
    error: string | null;
    code: string | null;
  }>({ key: "", photos: [], page: 0, loading: true, hasMore: false, error: null, code: null });
  const [busy, setBusy] = useState<string | null>(null);
  const key = `${q}|${orientation}|${color}`;
  const latest = useRef(key);
  latest.current = key;

  const load = useCallback(
    async (page: number) => {
      const convex = editor.convex;
      if (!convex) return;
      const requestKey = key;
      setResults((r) => ({
        ...r,
        loading: true,
        error: null,
        ...(page === 1 ? { key: requestKey } : {}),
      }));
      try {
        const res = await convex.action(refs.stockSearch, {
          query: q,
          page,
          ...(orientation !== "any" ? { orientation } : {}),
          ...(color ? { color: `#${color}` } : {}),
        });
        if (latest.current !== requestKey) return;
        setResults((r) => {
          const seen = new Set(page === 1 ? [] : r.photos.map((p) => p.id));
          const fresh = res.photos.filter((p) => !seen.has(p.id));
          return {
            key: requestKey,
            photos: page === 1 ? res.photos : [...r.photos, ...fresh],
            page,
            loading: false,
            hasMore: res.hasMore && fresh.length > 0,
            error: null,
            code: null,
          };
        });
      } catch (e) {
        if (latest.current !== requestKey) return;
        setResults((r) => ({ ...r, loading: false, error: errorMessage(e), code: errorCode(e) }));
      }
    },
    [editor, key, q, orientation, color],
  );

  useEffect(() => {
    if (editor.convex) void load(1);
  }, [editor, load]);

  const use = async (photo: StockPhoto) => {
    const convex = editor.convex;
    if (!convex || !workspaceId || !editor.canEdit) return;
    setBusy(photo.id);
    try {
      const { asset } = await convex.action(refs.stockUse, {
        workspaceId,
        photo: {
          id: photo.id,
          url: photo.url,
          author: photo.author,
          authorUrl: photo.authorUrl,
          sourceUrl: photo.sourceUrl,
          ...(photo.description ? { description: photo.description } : {}),
          ...(photo.downloadLocation ? { downloadLocation: photo.downloadLocation } : {}),
        },
      });
      const ref = {
        ...assetRefFromView(asset),
        source: "stock" as const,
        attribution: { author: photo.author, license: photo.license, url: photo.sourceUrl },
      };
      if (asset.url) editor.assets.prime(ref.id, asset.url);
      const size = fitToPage(
        asset.width ?? photo.width,
        asset.height ?? photo.height,
        editor.currentPage(),
        0.8,
      );
      const node = createImage({
        assetId: ref.id,
        name: photo.description ? capitalize(photo.description).slice(0, 60) : "Photo",
        role: "photo",
        alt: photo.description || undefined,
        ...size,
      });
      await insertSubtree(editor, [node], { label: "Add photo", assets: [ref] });
      editor.telemetry("stock_photo_used", { provider: photo.provider });
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't add the photo",
        description: errorMessage(e),
      });
    } finally {
      setBusy(null);
    }
  };

  if (!editor.convex) {
    return (
      <PanelBody>
        <PanelEmpty
          icon={<Camera />}
          title={
            <>
              millions of <em className="text-accent">photos</em>
            </>
          }
          description="Stock photos come through the Desyn backend. Open the design in the app to search them."
        />
      </PanelBody>
    );
  }
  if (results.code === "NOT_CONFIGURED") {
    return (
      <PanelBody>
        <PanelEmpty
          icon={<KeyRound />}
          title={
            <>
              stock photos are <em className="text-accent">resting</em>
            </>
          }
          description={
            <>
              This server has no stock photo provider yet. An admin can add{" "}
              <code className="rounded bg-fg/8 px-1 font-mono text-[11px] text-fg-secondary">
                UNSPLASH_ACCESS_KEY
              </code>{" "}
              or{" "}
              <code className="rounded bg-fg/8 px-1 font-mono text-[11px] text-fg-secondary">
                PEXELS_API_KEY
              </code>{" "}
              to the backend environment. Until then, upload your own photos.
            </>
          }
        />
      </PanelBody>
    );
  }

  const showing = results.key === key ? results.photos : [];
  const loadingFirst = results.loading && results.key !== key;
  const sources = {
    unsplash: showing.some((p) => p.provider === "unsplash"),
    pexels: showing.some((p) => p.provider === "pexels"),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search photos"
          placeholder="Search Unsplash and Pexels"
        />
        {!query.trim() ? (
          <ChipRow
            label="Photo ideas"
            value={suggestion}
            onChange={setSuggestion}
            options={SUGGESTIONS.map((s) => ({ value: s, label: capitalize(s) }))}
          />
        ) : null}
        <div className="flex gap-1.5">
          <ChipRow
            label="Orientation"
            value={orientation}
            onChange={setOrientation}
            options={[
              { value: "any", label: "Any shape" },
              { value: "landscape", label: "Landscape" },
              { value: "portrait", label: "Portrait" },
              { value: "square", label: "Square" },
            ]}
          />
        </div>
        <ColorDots value={color} onChange={setColor} />
      </div>
      <PanelBody>
        {results.error && showing.length === 0 ? (
          <PanelEmpty
            icon={<ImageOff />}
            title={
              <>
                photos are <em className="text-accent">out of reach</em>
              </>
            }
            description={results.error}
          />
        ) : loadingFirst && showing.length === 0 ? (
          <div className="columns-2 gap-2">
            <TileSkeletons count={8} ratio={0.75} />
          </div>
        ) : showing.length === 0 && !results.loading ? (
          <PanelEmpty
            icon={<Camera />}
            title={
              <>
                no photos <em className="text-accent">found</em>
              </>
            }
            description={`Nothing matches “${q}”. Try a broader word.`}
          />
        ) : (
          <>
            <div className="columns-2 gap-2">
              {showing.map((p) => (
                <PhotoCard
                  key={p.id}
                  photo={p}
                  busy={busy === p.id}
                  disabled={!canEdit}
                  onUse={() => void use(p)}
                />
              ))}
            </div>
            <LoadMore
              onLoad={() => void load(results.page + 1)}
              loading={results.loading}
              visible={results.hasMore && showing.length > 0}
            />
            <p className="pt-2 text-center text-2xs text-fg-muted">
              Photos from{" "}
              {sources.unsplash ? (
                <a
                  className="underline-offset-2 hover:text-fg hover:underline"
                  href="https://unsplash.com/?utm_source=desyn&utm_medium=referral"
                  target="_blank"
                  rel="noreferrer"
                >
                  Unsplash
                </a>
              ) : null}
              {sources.unsplash && sources.pexels ? " and " : null}
              {sources.pexels ? (
                <a
                  className="underline-offset-2 hover:text-fg hover:underline"
                  href="https://www.pexels.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  Pexels
                </a>
              ) : null}
            </p>
          </>
        )}
      </PanelBody>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ColorDots({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form chrome to a row of color dots
    <div role="group" aria-label="Photo color" className="flex items-center gap-1.5">
      {COLORS.map((c) => (
        <button
          key={c.value || "any"}
          type="button"
          aria-pressed={value === c.value}
          aria-label={c.label}
          title={c.label}
          onClick={() => onChange(c.value)}
          className={cn(
            "grid size-6 cursor-pointer place-items-center rounded-full border transition-[box-shadow,border-color] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === c.value
              ? "border-accent shadow-[0_0_0_2px_var(--surface-1),0_0_0_3.5px_var(--accent)]"
              : "border-line-subtle hover:border-line",
          )}
        >
          {c.value ? (
            // The inset ring keeps dark swatches visible on the dark surface.
            <span
              className="size-4 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]"
              style={{ background: `#${c.value}` }}
            />
          ) : (
            <span className="text-[9px] font-medium text-fg-muted">All</span>
          )}
        </button>
      ))}
    </div>
  );
}

function PhotoCard({
  photo,
  busy,
  disabled,
  onUse,
}: {
  photo: StockPhoto;
  busy: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  return (
    <div className="group/tile relative mb-2 break-inside-avoid overflow-hidden rounded-[10px] bg-surface-2">
      <button
        type="button"
        aria-label={`Add photo by ${photo.author}${photo.description ? `: ${photo.description}` : ""}`}
        disabled={disabled}
        aria-busy={busy || undefined}
        onClick={onUse}
        className="block w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
        style={{
          aspectRatio: String(photo.width / Math.max(photo.height, 1)),
          background: photo.color ?? undefined,
        }}
      >
        <img
          src={photo.thumbUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-full object-cover transition-transform duration-500 ease-out group-hover/tile:scale-[1.04]"
        />
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/75 to-transparent px-2 pt-6 pb-1.5 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100 group-focus-within/tile:opacity-100">
        <a
          href={photo.authorUrl}
          target="_blank"
          rel="noreferrer"
          className="pointer-events-auto block truncate text-[10px] text-white/90 underline-offset-2 hover:underline"
        >
          {photo.author} · {photo.provider === "unsplash" ? "Unsplash" : "Pexels"}
        </a>
      </div>
      {busy ? (
        <span className="absolute inset-0 grid place-items-center bg-surface-1/55 backdrop-blur-[2px]">
          <span className="size-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
        </span>
      ) : null}
    </div>
  );
}
