"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, Search, Star } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { isStringArray } from "../lib/storage.ts";
import { focusRing } from "../lib/styles.ts";
import { usePersistentState } from "../lib/use-persistent-state.ts";
import { Input } from "./input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

export type FontCategory = "sans-serif" | "serif" | "display" | "handwriting" | "monospace";

export interface FontOption {
  /** CSS family name, also the value. */
  family: string;
  /** Display name when it differs from the CSS family (e.g. "Instrument Sans" for a variable face). */
  label?: string;
  category?: FontCategory;
  /** Available weights (shown as a hint). */
  weights?: number[];
  /** Where it comes from ("Brand", "Uploaded", "Google"); shown as a small tag. */
  source?: string;
}

type CategoryFilter = "all" | "favorites" | FontCategory;

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: "All",
  favorites: "Favorites",
  "sans-serif": "Sans",
  serif: "Serif",
  display: "Display",
  handwriting: "Script",
  monospace: "Mono",
};

const FALLBACKS: Record<FontCategory, string> = {
  "sans-serif": "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  display: "ui-sans-serif, system-ui, sans-serif",
  handwriting: "cursive",
  monospace: "ui-monospace, monospace",
};

const RECENT_KEY = "desyn-recent-fonts";
const FAVORITES_KEY = "desyn-favorite-fonts";
const RECENT_MAX = 8;
const NO_FONTS: string[] = [];

/** CSS `font-family` value for previewing a font with a sensible fallback. */
export function fontStack(font: FontOption): string {
  // Family names can come from uploaded fonts: escape backslashes before quotes so the string
  // can never terminate early, and drop control characters.
  const family = Array.from(font.family)
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join("")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${family}", ${FALLBACKS[font.category ?? "sans-serif"] ?? FALLBACKS["sans-serif"]}`;
}

export interface FontPickerProps {
  fonts: FontOption[];
  value?: string;
  onChange?: (family: string) => void;
  /**
   * Loads a font for previewing. Called once per family when its row first scrolls into view.
   * Resolve when the face is ready so the preview can fade in.
   */
  loadFont?: (font: FontOption) => Promise<void> | void;
  favorites?: string[];
  onFavoritesChange?: (families: string[]) => void;
  recent?: string[];
  onRecentChange?: (families: string[]) => void;
  /** Persist favorites/recents in localStorage when uncontrolled (default true). */
  persist?: boolean;
  /** Text rendered in each font (default: the family name). */
  previewText?: string;
  /** Height of the list in px. */
  listHeight?: number;
  /** Focus the search field on mount (default true). */
  autoFocus?: boolean;
  className?: string;
}

type Row =
  | { kind: "header"; key: string; label: string }
  | { kind: "font"; key: string; font: FontOption; section: string };

/**
 * Searchable, virtualized font list with live previews, category filters, recents and favorites.
 * Keyboard: type to search, ↑/↓ to move, Enter to choose. Fonts load lazily through `loadFont`.
 */
export function FontPicker({
  fonts,
  value,
  onChange,
  loadFont,
  favorites: favoritesProp,
  onFavoritesChange,
  recent: recentProp,
  onRecentChange,
  persist = true,
  previewText,
  listHeight = 320,
  autoFocus = true,
  className,
}: FontPickerProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  // Persisted lists are hydration-safe and shared across pickers; props take over when given.
  const [storedFavorites, setStoredFavorites] = usePersistentState(
    persist && favoritesProp === undefined ? FAVORITES_KEY : null,
    isStringArray,
    NO_FONTS,
  );
  const [storedRecent, setStoredRecent] = usePersistentState(
    persist && recentProp === undefined ? RECENT_KEY : null,
    isStringArray,
    NO_FONTS,
  );
  const favorites = favoritesProp ?? storedFavorites;
  const recent = recentProp ?? storedRecent;
  const setFavorites = (next: string[]) => {
    if (favoritesProp === undefined) setStoredFavorites(next);
    onFavoritesChange?.(next);
  };
  const setRecent = (next: string[]) => {
    if (recentProp === undefined) setStoredRecent(next);
    onRecentChange?.(next);
  };
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const requested = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);

  const byFamily = useMemo(() => new Map(fonts.map((f) => [f.family, f])), [fonts]);
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (f: FontOption) =>
      (!q || f.family.toLowerCase().includes(q) || (f.label?.toLowerCase().includes(q) ?? false)) &&
      (category === "all" ||
        (category === "favorites"
          ? favSet.has(f.family)
          : (f.category ?? "sans-serif") === category));
    const out: Row[] = [];
    if (!q && category === "all") {
      const recentFonts = recent.map((r) => byFamily.get(r)).filter((f): f is FontOption => !!f);
      if (recentFonts.length) {
        out.push({ kind: "header", key: "h-recent", label: "Recently used" });
        for (const f of recentFonts)
          out.push({ kind: "font", key: `recent-${f.family}`, font: f, section: "recent" });
        out.push({ kind: "header", key: "h-all", label: "All fonts" });
      }
    }
    for (const f of fonts)
      if (matches(f)) out.push({ kind: "font", key: `all-${f.family}`, font: f, section: "all" });
    return out;
  }, [fonts, query, category, recent, byFamily, favSet]);

  const fontRowIndexes = useMemo(
    () => rows.flatMap((r, i) => (r.kind === "font" ? [i] : [])),
    [rows],
  );
  const [active, setActive] = useState(0);
  useEffect(() => {
    // Reset to the selected font (or first match) whenever the visible list changes.
    const sel = rows.findIndex((r) => r.kind === "font" && r.font.family === value);
    setActive(sel >= 0 ? sel : (fontRowIndexes[0] ?? 0));
  }, [rows, value, fontRowIndexes]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? 28 : 36),
    overscan: 8,
  });
  const vItems = virtualizer.getVirtualItems();

  // Lazy-load the faces that are on screen.
  const visibleFamilies = vItems
    .map((v) => rows[v.index])
    .flatMap((r) => (r?.kind === "font" ? [r.font] : []));
  const visibleKey = visibleFamilies.map((f) => f.family).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the visible family list
  useEffect(() => {
    if (!loadFont) return;
    for (const font of visibleFamilies) {
      if (requested.current.has(font.family)) continue;
      requested.current.add(font.family);
      Promise.resolve(loadFont(font))
        .then(() => setLoaded((prev) => new Set(prev).add(font.family)))
        .catch(() => setLoaded((prev) => new Set(prev).add(font.family)));
    }
  }, [visibleKey, loadFont]);

  const choose = (family: string) => {
    setRecent([family, ...recent.filter((f) => f !== family)].slice(0, RECENT_MAX));
    onChange?.(family);
  };

  const toggleFavorite = (family: string) =>
    setFavorites(
      favorites.includes(family) ? favorites.filter((f) => f !== family) : [...favorites, family],
    );

  const moveActive = (dir: number | "first" | "last") => {
    if (!fontRowIndexes.length) return;
    const pos = fontRowIndexes.indexOf(active);
    let nextPos: number;
    if (dir === "first") nextPos = 0;
    else if (dir === "last") nextPos = fontRowIndexes.length - 1;
    else nextPos = Math.max(0, Math.min(fontRowIndexes.length - 1, (pos < 0 ? -1 : pos) + dir));
    const idx = fontRowIndexes[nextPos] ?? 0;
    setActive(idx);
    virtualizer.scrollToIndex(idx, { align: "auto" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      // A page is the number of font rows that fit in the list.
      const page = Math.max(1, Math.floor(listHeight / 36) - 1);
      moveActive(e.key === "PageDown" ? page : -page);
    } else if (e.key === "Enter") {
      const row = rows[active];
      if (row?.kind === "font") {
        e.preventDefault();
        choose(row.font.family);
      }
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const categories: CategoryFilter[] = [
    "all",
    "favorites",
    "sans-serif",
    "serif",
    "display",
    "handwriting",
    "monospace",
  ];
  const presentCategories = categories.filter(
    (c) =>
      c === "all" || c === "favorites" || fonts.some((f) => (f.category ?? "sans-serif") === c),
  );

  return (
    <div className={cn("flex w-[280px] flex-col", className)}>
      <div className="flex flex-col gap-2 p-2 pb-1.5">
        <Input
          size="sm"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows[active]?.kind === "font" ? optionId(active) : undefined}
          aria-label="Search fonts"
          placeholder="Search fonts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          leading={<Search />}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: chip filter group, not a form fieldset */}
        <div
          role="group"
          aria-label="Font categories"
          className="-mx-0.5 flex gap-1 overflow-x-auto px-0.5 pb-0.5 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_85%,transparent)]"
        >
          {presentCategories.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                "h-6 shrink-0 cursor-pointer rounded-full px-2.5 text-2xs font-medium transition-colors",
                category === c
                  ? "bg-accent-tint text-accent-text shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.35)]"
                  : "bg-fg/5 text-fg-muted hover:bg-fg/8 hover:text-fg-secondary",
                focusRing,
              )}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={scrollRef}
        id={listId}
        role="listbox"
        aria-label="Fonts"
        className="relative overflow-y-auto border-t border-line-subtle px-1 py-1"
        style={{ height: listHeight }}
      >
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <span className="font-serif text-lg text-fg">No fonts found</span>
            <span className="text-xs text-fg-muted">
              {category === "favorites"
                ? "Star a font to keep it here."
                : "Try another name or category."}
            </span>
          </div>
        ) : null}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {vItems.map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            const style = {
              position: "absolute" as const,
              top: v.start,
              left: 0,
              right: 0,
              height: v.size,
            };
            if (row.kind === "header") {
              return (
                <div
                  key={row.key}
                  role="presentation"
                  style={style}
                  className="flex items-end px-2 pb-1 text-2xs font-medium text-fg-muted"
                >
                  {row.label}
                </div>
              );
            }
            const f = row.font;
            const isSelected = f.family === value;
            const isActive = v.index === active;
            const isLoaded = !loadFont || loaded.has(f.family);
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input (aria-activedescendant)
              <div
                key={row.key}
                id={optionId(v.index)}
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onPointerMove={() => setActive(v.index)}
                onClick={() => choose(f.family)}
                style={style}
                className="group/font px-0.5"
              >
                <div
                  className={cn(
                    "flex h-full cursor-pointer items-center gap-2 rounded-[6px] pr-1 pl-2 transition-colors",
                    isActive ? "bg-fg/8" : "",
                  )}
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    {isSelected ? (
                      <Check className="size-3.5 text-accent" strokeWidth={2.5} />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[15px] text-fg transition-opacity duration-300",
                      isLoaded ? "opacity-100" : "opacity-40",
                    )}
                    style={{ fontFamily: isLoaded ? fontStack(f) : undefined }}
                  >
                    {previewText ?? f.label ?? f.family}
                  </span>
                  {previewText ? (
                    <span className="shrink-0 truncate text-2xs text-fg-muted">
                      {f.label ?? f.family}
                    </span>
                  ) : null}
                  {f.source ? (
                    <span className="shrink-0 rounded-full bg-fg/6 px-1.5 py-px text-[10px] text-fg-muted">
                      {f.source}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={
                      favSet.has(f.family) ? `Unfavorite ${f.family}` : `Favorite ${f.family}`
                    }
                    aria-pressed={favSet.has(f.family)}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(f.family);
                    }}
                    className={cn(
                      "grid size-6 shrink-0 cursor-pointer place-items-center rounded-[5px] transition-[opacity,color] hover:bg-fg/8",
                      favSet.has(f.family)
                        ? "text-accent opacity-100"
                        : "text-fg-muted opacity-0 group-hover/font:opacity-100",
                    )}
                  >
                    <Star className={cn("size-3.5", favSet.has(f.family) && "fill-current")} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export interface FontPickerButtonProps extends Omit<FontPickerProps, "className" | "autoFocus"> {
  /** Accessible name, e.g. "Font family". */
  label?: string;
  placeholder?: ReactNode;
  className?: string;
}

/** Inspector trigger showing the current family in its own face; opens `FontPicker` in a popover. */
export function FontPickerButton({
  label = "Font family",
  placeholder = "Choose font",
  className,
  ...props
}: FontPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const current = props.fonts.find((f) => f.family === props.value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${props.value ?? "none"}`}
          className={cn(
            "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border border-line-subtle bg-surface-2 px-2.5 text-left text-sm text-fg shadow-inset transition-colors hover:border-line data-[state=open]:border-transparent data-[state=open]:ring-2 data-[state=open]:ring-ring",
            focusRing,
            className,
          )}
        >
          <span
            className="min-w-0 flex-1 truncate"
            style={current ? { fontFamily: fontStack(current) } : undefined}
          >
            {current?.label ?? props.value ?? (
              <span className="text-fg-placeholder">{placeholder}</span>
            )}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent flush align="start" className="bg-surface-1/95 p-0" aria-label={label}>
        <FontPicker
          {...props}
          onChange={(family) => {
            props.onChange?.(family);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
