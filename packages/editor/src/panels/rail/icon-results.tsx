"use client";

import { createSvg } from "@desyn/schema";
import { cn } from "@desyn/ui";
import { Smile, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { svgSize } from "../../commands/clipboard.ts";
import { useEditor } from "../../context.tsx";
import {
  ICON_SET_LABELS,
  ICON_SETS,
  ICON_SUGGESTIONS,
  type IconData,
  iconDataUrl,
  iconSvg,
  loadIcons,
  STICKER_SETS,
  STICKER_SUGGESTIONS,
  searchIcons,
} from "../lib/iconify.ts";
import { insertSubtree } from "../lib/insert.ts";
import { pageInk } from "../lib/page-color.ts";
import { ChipRow, PanelEmpty, Tile, TileGrid, TileSkeletons } from "../ui/primitives.tsx";

/**
 * Icon / sticker results from Iconify. With an empty query the first suggestion is shown, so the section is
 * never blank. Clicking inserts the SVG as an inline vector layer, recolored to read on the page.
 */
export function IconResults({
  query,
  kind,
  limit,
  showSets = false,
}: {
  query: string;
  kind: "icons" | "stickers";
  limit: number;
  showSets?: boolean;
}) {
  const editor = useEditor();
  const suggestions = kind === "icons" ? ICON_SUGGESTIONS : STICKER_SUGGESTIONS;
  const sets: readonly string[] = kind === "icons" ? ICON_SETS : STICKER_SETS;
  const [set, setSet] = useState<string>("all");
  const [suggestion, setSuggestion] = useState(suggestions[0] as string);
  const effective = query || suggestion;
  const [state, setState] = useState<{
    key: string;
    icons: string[];
    data: Map<string, IconData>;
    error: string | null;
    loading: boolean;
  }>({ key: "", icons: [], data: new Map(), error: null, loading: true });
  const [busy, setBusy] = useState<string | null>(null);
  const prefixes = set === "all" ? sets : [set];
  const key = `${effective}|${prefixes.join(",")}|${limit}`;

  // `key` encodes `effective`, `prefixes` (from `set` / `kind`) and `limit`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    searchIcons(effective, prefixes, { limit, signal: ctrl.signal })
      .then(async (found) => {
        const ids = found.slice(0, limit);
        const data = await loadIcons(ids, { signal: ctrl.signal });
        setState({
          key,
          icons: ids.filter((id) => data.has(id)),
          data,
          error: null,
          loading: false,
        });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          key,
          icons: [],
          data: new Map(),
          error: e instanceof Error ? e.message : "Icon search failed.",
          loading: false,
        });
      });
    return () => ctrl.abort();
  }, [key]);

  const insert = async (id: string) => {
    if (!editor.canEdit) return;
    setBusy(id);
    try {
      // Monochrome icon sets take the page's ink color; stickers keep their own colors.
      const icon = state.data.get(id) ?? (await loadIcons([id])).get(id);
      if (!icon) throw new Error("The icon could not be loaded.");
      const markup = iconSvg(icon, kind === "icons" ? pageInk(editor) : undefined);
      const natural = svgSize(markup);
      const side = kind === "icons" ? 160 : 220;
      const ratio = natural.width / Math.max(natural.height, 1);
      const node = createSvg({
        markup,
        name: id.split(":")[1]?.replace(/-/g, " ") ?? "Icon",
        width: ratio >= 1 ? side : Math.round(side * ratio),
        height: ratio >= 1 ? Math.round(side / ratio) : side,
        role: kind === "icons" ? "icon" : "decoration",
        meta: { iconify: id },
      });
      await insertSubtree(editor, [node], { label: kind === "icons" ? "Add icon" : "Add sticker" });
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't add that icon",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!query ? (
        <ChipRow
          label={`${kind === "icons" ? "Icon" : "Sticker"} suggestions`}
          value={suggestion}
          onChange={setSuggestion}
          options={suggestions.map((s) => ({ value: s, label: s }))}
        />
      ) : null}
      {showSets ? (
        <ChipRow
          label="Icon set"
          value={set}
          onChange={setSet}
          options={[
            { value: "all", label: "All sets" },
            ...sets.map((s) => ({ value: s, label: ICON_SET_LABELS[s] ?? s })),
          ]}
        />
      ) : null}
      {state.error ? (
        <PanelEmpty
          icon={kind === "icons" ? <Star /> : <Smile />}
          title={
            <>
              icons are <em className="text-accent">offline</em>
            </>
          }
          description="The icon library could not be reached. Check your connection and try again."
        />
      ) : state.loading && state.key !== key ? (
        <TileGrid min={kind === "icons" ? 44 : 56}>
          <TileSkeletons count={Math.min(limit, kind === "icons" ? 12 : 8)} />
        </TileGrid>
      ) : state.icons.length === 0 ? (
        <p className="py-4 text-center text-xs text-fg-muted">
          No {kind} match “{effective}”.
        </p>
      ) : (
        <TileGrid min={kind === "icons" ? 44 : 56} className={cn(state.loading && "opacity-60")}>
          {state.icons.map((id) => (
            <Tile
              key={id}
              label={`${id.split(":")[1]?.replace(/-/g, " ")} (${ICON_SET_LABELS[id.split(":")[0] ?? ""] ?? ""})`}
              busy={busy === id}
              disabled={!editor.canEdit}
              onClick={() => void insert(id)}
            >
              <IconPreview icon={state.data.get(id)} mono={kind === "icons"} />
            </Tile>
          ))}
        </TileGrid>
      )}
    </div>
  );
}

/**
 * Monochrome icons are drawn through a CSS mask filled with the current text color (follows the theme and
 * the tile's hover color); stickers keep their colors as an image. Both from data URLs, never inline markup.
 */
function IconPreview({ icon, mono }: { icon: IconData | undefined; mono: boolean }) {
  if (!icon) return null;
  const url = iconDataUrl(icon);
  if (mono) {
    return (
      <span
        aria-hidden
        className="size-6 bg-current text-fg-secondary transition-colors group-hover/tile:text-accent"
        style={{
          maskImage: `url("${url}")`,
          WebkitMaskImage: `url("${url}")`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    );
  }
  return <img src={url} alt="" draggable={false} className="size-9" />;
}
