"use client";

import { applyTransaction, makeTransaction, pages } from "@desyn/doc-ops";
import {
  type Design,
  getPreset,
  PAGE_PRESETS,
  type PagePreset,
  type PresetCategory,
} from "@desyn/schema";
import { Checkbox, cn, IconButton, Input, SegmentedControl, Skeleton, Switch } from "@desyn/ui";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEditorStore } from "../../../context.tsx";
import type { ModalDef, ModalProps } from "../../../shell/extensions.ts";
import { useAiSession } from "../hooks.ts";
import { FieldLabel, useAiModule, useWorkflowEstimate, WorkflowDialog } from "./common.tsx";
import { PagePreview, useAssetUrls } from "./page-preview.tsx";

const QUICK = [
  "instagram-story",
  "instagram-portrait",
  "facebook-post",
  "linkedin-post",
  "x-post",
  "youtube-thumbnail",
  "pinterest-pin",
  "presentation-16-9",
];

const CATEGORY_LABELS: Record<PresetCategory, string> = {
  social: "Social",
  ads: "Ads",
  video: "Video",
  presentation: "Presentation",
  web: "Web",
  print: "Print",
  other: "Other",
};

const MAX_PREVIEWS = 6;

interface Preview {
  preset: PagePreset;
  design: Design | null;
  layout: string | null;
  error: string | null;
}

/** Reflowed copies of the current page at each preset (the same reflow the workflow runs). */
function useReflowPreviews(selected: string[]): Preview[] {
  const ai = useAiModule();
  const session = useAiSession();
  const editor = session.editor;
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const key = selected.slice(0, MAX_PREVIEWS).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the selected preset ids
  useEffect(() => {
    if (!design || !pageId) return;
    const wanted = key
      ? key.split(",").flatMap((id) => (getPreset(id) ? [getPreset(id) as PagePreset] : []))
      : [];
    setPreviews(wanted.map((preset) => ({ preset, design: null, layout: null, error: null })));
    if (!ai || wanted.length === 0) return;
    let alive = true;
    const measure = (items: Parameters<NonNullable<typeof editor.engineClient>["measure"]>[0]) =>
      editor.engineClient?.hasDesign
        ? editor.engineClient.measure(items)
        : Promise.resolve(items.map((it) => ai.measureText(it as never)));
    void (async () => {
      const out: Preview[] = [];
      for (const preset of wanted) {
        try {
          const { ops, layout } = await ai.reflowPage(design, pageId, preset, {
            measure: (items) => measure(items as never) as never,
          });
          const next = applyTransaction(design, makeTransaction(ops, "Reflow preview"), {
            validateNodes: false,
          }).design;
          out.push({ preset, design: next, layout, error: null });
        } catch (e) {
          out.push({
            preset,
            design: null,
            layout: null,
            error: e instanceof Error ? e.message : "No preview",
          });
        }
        if (alive)
          setPreviews([
            ...out,
            ...wanted
              .slice(out.length)
              .map((p) => ({ preset: p, design: null, layout: null, error: null })),
          ]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ai, design, pageId, key]);
  return previews;
}

const LAYOUT_LABELS: Record<string, string> = {
  anchored: "Anchored",
  "restacked-vertical": "Restacked vertically",
  "restacked-horizontal": "Restacked horizontally",
};

function ResizeDialog({ editor, props, close }: ModalProps) {
  const session = useAiSession();
  const initial = Array.isArray(props.presets)
    ? (props.presets as unknown[]).filter(
        (p): p is string => typeof p === "string" && !!getPreset(p),
      )
    : [];
  const [selected, setSelected] = useState<string[]>(
    initial.length ? initial : ["instagram-story"],
  );
  const [query, setQuery] = useState("");
  const [pagesMode, setPagesMode] = useState<"all" | "first">("all");
  const [polish, setPolish] = useState(false);
  const [busy, setBusy] = useState(false);
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const urls = useAssetUrls(editor, design);
  const previews = useReflowPreviews(selected);
  const multiPage = design ? pages(design).length > 1 : false;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = PAGE_PRESETS.filter(
      (p) =>
        !q ||
        p.label.toLowerCase().includes(q) ||
        p.id.includes(q) ||
        (p.platform ?? "").includes(q),
    );
    const out = new Map<PresetCategory, PagePreset[]>();
    for (const p of list) out.set(p.category, [...(out.get(p.category) ?? []), p]);
    return [...out.entries()];
  }, [query]);

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? (s.includes(id) ? s : [...s, id]) : s.filter((x) => x !== id)));
  const input = selected.length ? { presets: selected, pages: pagesMode, polish } : null;
  const estimate = useWorkflowEstimate("resize", input);

  const start = async () => {
    if (!input) return;
    setBusy(true);
    const id = await session.startWorkflow(
      "resize",
      input,
      `Magic resize · ${selected.length} size${selected.length === 1 ? "" : "s"}`,
    );
    setBusy(false);
    if (id) close();
  };

  return (
    <WorkflowDialog
      action="workflow.resize"
      title={
        <>
          magic <em className="text-accent">resize</em>
        </>
      }
      description="Copies this design to new sizes. Layers reflow by their roles; text is re-measured so nothing overflows."
      close={close}
      estimate={estimate}
      startLabel={`Create ${selected.length} design${selected.length === 1 ? "" : "s"}`}
      canStart={selected.length > 0 && selected.length <= 40}
      onStart={() => void start()}
      busy={busy}
      size="xl"
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col">
          <Input
            size="sm"
            leading={<Search />}
            placeholder="Search sizes"
            aria-label="Search sizes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!query ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {QUICK.map((id) => {
                const p = getPreset(id);
                if (!p) return null;
                const on = selected.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(id, !on)}
                    className={cn(
                      "h-6 rounded-full px-2 text-2xs transition-colors",
                      on
                        ? "bg-accent-tint text-accent-text"
                        : "bg-fg/[0.04] text-fg-muted hover:text-fg",
                    )}
                  >
                    {p.label.replace(/ \(.*\)$/, "")}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="mt-3 max-h-[340px] overflow-y-auto pr-1">
            {groups.map(([cat, list]) => (
              <div key={cat} className="mb-3">
                <p className="mb-1 text-2xs font-medium text-fg-muted">{CATEGORY_LABELS[cat]}</p>
                <ul className="space-y-0.5">
                  {list.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-[6px] px-1 py-1 hover:bg-fg/4"
                    >
                      <Checkbox
                        checked={selected.includes(p.id)}
                        onCheckedChange={(v) => toggle(p.id, v === true)}
                        label={<span className="text-xs text-fg-secondary">{p.label}</span>}
                      />
                      <span className="shrink-0 font-mono text-[10px] text-fg-placeholder">
                        {p.physical
                          ? `${p.physical.width}×${p.physical.height} ${p.physical.unit}`
                          : `${p.width}×${p.height}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <FieldLabel>
            Preview{pageId && design?.nodes[pageId] ? ` · ${design.nodes[pageId]?.name}` : ""}
          </FieldLabel>
          {previews.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-fg-muted">
              Pick sizes on the left to see how the layout reflows.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {previews.map((p) => (
                <figure key={p.preset.id} className="group relative flex flex-col gap-1.5">
                  <div className="grid aspect-square place-items-center rounded-card bg-canvas p-2.5">
                    {p.design && pageId ? (
                      <PagePreview
                        design={p.design}
                        pageId={pageId}
                        urls={urls}
                        label={`${p.preset.label} preview`}
                        className="max-h-full max-w-full rounded-[2px] shadow-page"
                      />
                    ) : p.error ? (
                      <span className="text-2xs text-fg-muted">{p.error}</span>
                    ) : (
                      <Skeleton className="size-3/4" />
                    )}
                  </div>
                  <figcaption className="flex items-center justify-between gap-1 text-2xs">
                    <span className="truncate text-fg-secondary">{p.preset.label}</span>
                    <IconButton
                      label={`Remove ${p.preset.label}`}
                      size="xs"
                      tooltip={false}
                      onClick={() => toggle(p.preset.id, false)}
                    >
                      <X />
                    </IconButton>
                  </figcaption>
                  {p.layout ? (
                    <span className="-mt-1 text-[10px] text-fg-placeholder">
                      {LAYOUT_LABELS[p.layout] ?? p.layout}
                    </span>
                  ) : null}
                </figure>
              ))}
            </div>
          )}
          {selected.length > MAX_PREVIEWS ? (
            <p className="mt-2 text-2xs text-fg-muted">
              Showing {MAX_PREVIEWS} of {selected.length} sizes.
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-3 border-t border-line-subtle pt-4">
            {multiPage ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-fg-secondary">Pages</span>
                <SegmentedControl
                  size="sm"
                  aria-label="Pages to resize"
                  value={pagesMode}
                  onValueChange={setPagesMode}
                  options={[
                    { value: "all", label: "All pages" },
                    { value: "first", label: "First page" },
                  ]}
                />
              </div>
            ) : null}
            <Switch
              checked={polish}
              onCheckedChange={setPolish}
              label="Polish with AI"
              description="After the reflow, the agent fixes remaining spacing and hierarchy issues (uses agent credits)."
            />
          </div>
        </div>
      </div>
    </WorkflowDialog>
  );
}

export const resizeModal: ModalDef = { id: "ai.workflow.resize", component: ResizeDialog };
