"use client";

import { DESIGN_KIND_INFO, type DesignKind } from "@desyn/schema";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ProBadge,
} from "@desyn/ui";
import { CopyPlus, LayoutTemplate, Replace, Star, WifiOff } from "lucide-react";
import { useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";
import {
  errorMessage,
  refs,
  type TemplateView,
  useBackendQuery,
  usePaginatedBackendQuery,
} from "../backend.ts";
import { useGate } from "../lib/gate.ts";
import {
  parseTemplateDesign,
  type TemplateApplyMode,
  templateImportOps,
} from "../lib/template-import.ts";
import {
  ChipRow,
  LoadMore,
  PanelBody,
  PanelEmpty,
  PanelSection,
  SearchField,
  TileSkeletons,
  useDebounced,
} from "../ui/primitives.tsx";

/**
 * Design: the template library (search, size and category filters) applied to the open design, either
 * replacing the current page or added as new pages. Templates are real designs: their pages are copied as
 * editable layers with fresh ids (lib/template-import.ts).
 */

export async function applyTemplate(
  editor: EditorController,
  template: Pick<TemplateView, "id" | "title" | "pageCount">,
  mode: TemplateApplyMode,
): Promise<boolean> {
  const convex = editor.convex;
  if (!convex || !editor.canEdit) return false;
  try {
    const { design: json } = await convex.query(refs.templatesGetDesign, {
      templateId: template.id,
    });
    const source = parseTemplateDesign(json);
    let firstPage: string | undefined;
    const result = await editor.apply(
      (design, s) => {
        const { ops, pageIds } = templateImportOps(design, source, {
          mode,
          currentPageId: s.pageId,
        });
        firstPage = pageIds[0];
        return ops;
      },
      {
        label:
          mode === "replace"
            ? `Apply template ${template.title}`
            : `Add pages from ${template.title}`,
      },
    );
    if (result && firstPage) editor.setPage(firstPage);
    editor.telemetry("template_applied", { mode, pages: template.pageCount });
    return !!result;
  } catch (e) {
    editor.notify({
      kind: "error",
      title: "Couldn't apply the template",
      description: errorMessage(e),
    });
    return false;
  }
}

export function DesignPanel() {
  const kind = useEditorStore((s) => (s.doc.design?.kind ?? "custom") as DesignKind);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"kind" | "all">(kind === "custom" ? "all" : "kind");
  const [category, setCategory] = useState("all");
  const q = useDebounced(query.trim(), 300);
  const categories = useBackendQuery(refs.templatesCategories, {});
  const kindFilter = scope === "kind" && kind !== "custom" ? { kind } : {};
  const catFilter = category !== "all" ? { category } : {};
  const listed = usePaginatedBackendQuery(
    refs.templatesList,
    q ? "skip" : { ...kindFilter, ...catFilter, sort: "popular" },
    16,
  );
  const searched = usePaginatedBackendQuery(
    refs.templatesSearch,
    q ? { query: q, ...kindFilter, ...catFilter } : "skip",
    16,
  );
  const results = q ? searched : listed;

  if (results.status === "unavailable") {
    return (
      <PanelBody>
        <PanelEmpty
          icon={<LayoutTemplate />}
          title={
            <>
              templates need the <em className="text-accent">cloud</em>
            </>
          }
          description="Open this design in the Desyn app to browse and apply templates."
        />
      </PanelBody>
    );
  }

  const kindLabel = DESIGN_KIND_INFO[kind]?.label ?? "This design";
  const topCategories = (categories.data ?? []).slice(0, 14);
  const items = results.items as TemplateView[];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search templates"
          placeholder="Search templates"
        />
        <ChipRow
          label="Template size"
          value={scope}
          onChange={setScope}
          options={[
            ...(kind !== "custom" ? [{ value: "kind" as const, label: kindLabel }] : []),
            { value: "all" as const, label: "All sizes" },
          ]}
        />
        {topCategories.length > 0 ? (
          <ChipRow
            label="Template category"
            value={category}
            onChange={setCategory}
            options={[
              { value: "all", label: "All" },
              ...topCategories.map((c) => ({ value: c.category, label: titleCase(c.category) })),
            ]}
          />
        ) : null}
      </div>
      <PanelBody>
        {results.status === "error" && items.length === 0 ? (
          <PanelEmpty
            icon={<WifiOff />}
            title={
              <>
                templates are <em className="text-accent">resting</em>
              </>
            }
            description={results.error ? errorMessage(results.error) : "Try again in a moment."}
          />
        ) : results.status === "loading" && items.length === 0 ? (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <TileSkeletons count={8} ratio={0.8} />
          </div>
        ) : items.length === 0 ? (
          <PanelEmpty
            icon={<LayoutTemplate />}
            title={
              <>
                nothing <em className="text-accent">here</em> yet
              </>
            }
            description={
              q
                ? `No templates match “${q}”. Try another word or all sizes.`
                : "No templates in this category yet. Try all sizes."
            }
          />
        ) : (
          <PanelSection className="pt-1">
            <div className="columns-2 gap-2 [column-fill:_balance]">
              {items.map((t) => (
                <TemplateCard key={t.id} template={t} />
              ))}
            </div>
            <LoadMore
              onLoad={results.loadMore}
              loading={results.loadingMore}
              visible={results.canLoadMore}
            />
          </PanelSection>
        )}
      </PanelBody>
    </div>
  );
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function TemplateCard({ template }: { template: TemplateView }) {
  const editor = useEditor();
  const gate = useGate();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [busy, setBusy] = useState(false);
  const locked = template.premium && gate.locked("templates.premium");
  const thumb = template.thumbnails[0];
  const ratio = thumb
    ? thumb.width / Math.max(thumb.height, 1)
    : template.width / Math.max(template.height, 1);
  const run = async (mode: TemplateApplyMode) => {
    if (template.premium && !gate.check("templates.premium")) return;
    setBusy(true);
    await applyTemplate(editor, template, mode);
    setBusy(false);
  };
  const favorite = () => {
    const convex = editor.convex;
    if (!convex) return;
    convex
      .mutation(refs.templatesFavorite, { templateId: template.id, favorite: !template.favorite })
      .catch((e: unknown) =>
        editor.notify({
          kind: "error",
          title: "Couldn't save the favorite",
          description: errorMessage(e),
        }),
      );
  };
  return (
    <div className="mb-2 break-inside-avoid">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!canEdit}>
          <button
            type="button"
            aria-label={`${template.title}${template.premium ? " (Pro)" : ""}`}
            aria-busy={busy || undefined}
            className="group/tile relative block w-full cursor-pointer overflow-hidden rounded-[10px] bg-surface-2 text-left outline-none transition-[box-shadow,transform] duration-200 hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] data-[state=open]:ring-1 data-[state=open]:ring-accent/60 disabled:cursor-default"
          >
            <span
              className="block w-full bg-surface-3"
              style={{ aspectRatio: String(Math.max(0.4, Math.min(2.5, ratio))) }}
            >
              {thumb?.url ? (
                <img
                  src={thumb.url}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  className="size-full object-cover transition-transform duration-500 ease-out group-hover/tile:scale-[1.03]"
                />
              ) : (
                <span className="grid size-full place-items-center text-fg-muted">
                  <LayoutTemplate className="size-5" />
                </span>
              )}
            </span>
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end bg-linear-to-t from-black/70 via-black/25 to-transparent px-2 pt-6 pb-1.5 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100">
              <span className="truncate text-2xs font-medium text-white">{template.title}</span>
            </span>
            {template.premium ? <ProBadge className="absolute top-1.5 left-1.5 scale-90" /> : null}
            {template.pageCount > 1 ? (
              <span className="absolute top-1.5 right-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] text-white tabular-nums backdrop-blur-sm">
                {template.pageCount} pages
              </span>
            ) : null}
            {busy ? (
              <span className="absolute inset-0 grid place-items-center bg-surface-1/60 backdrop-blur-[2px]">
                <span className="size-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="truncate">{template.title}</DropdownMenuLabel>
          <DropdownMenuItem icon={<Replace />} disabled={busy} onSelect={() => void run("replace")}>
            {template.pageCount > 1 ? "Replace this page with its pages" : "Replace this page"}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<CopyPlus />} disabled={busy} onSelect={() => void run("add")}>
            {template.pageCount > 1 ? `Add ${template.pageCount} pages` : "Add as a new page"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<Star className={cn(template.favorite && "fill-current text-accent")} />}
            onSelect={favorite}
          >
            {template.favorite ? "Remove from favorites" : "Add to favorites"}
          </DropdownMenuItem>
          {locked ? (
            <p className="px-2 pt-1.5 pb-1 text-2xs text-fg-muted">
              Premium template: part of Desyn Pro.
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
