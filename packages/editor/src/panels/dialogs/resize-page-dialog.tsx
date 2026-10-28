"use client";

import {
  applyTransaction,
  pages as listPages,
  type ResizeStrategy,
  resizePage,
} from "@desyn/doc-ops";
import {
  fromPx,
  type Id,
  type Op,
  PAGE_PRESETS,
  type PagePreset,
  type PresetCategory,
  toPx,
  type Unit,
} from "@desyn/schema";
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  NumberField,
  SegmentedControl,
  Select,
} from "@desyn/ui";
import { Link2, Link2Off } from "lucide-react";
import { useMemo, useState } from "react";
import { useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { ChipRow, SearchField } from "../ui/primitives.tsx";

/**
 * Resize a page (or every page) to a preset or a custom size. Content follows with a strategy from doc-ops
 * `resizePage`: scale to fit, fill, keep centered, stretch, or leave the content alone.
 */

const CATEGORIES: { value: PresetCategory | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "social", label: "Social" },
  { value: "presentation", label: "Slides" },
  { value: "print", label: "Print" },
  { value: "video", label: "Video" },
  { value: "web", label: "Web" },
  { value: "ads", label: "Ads" },
  { value: "other", label: "Other" },
];

const STRATEGIES: { value: ResizeStrategy; label: string; hint: string }[] = [
  { value: "scale", label: "Fit", hint: "Content scales to fit the new size, centered." },
  { value: "fill", label: "Fill", hint: "Content scales to cover the new size; edges may crop." },
  { value: "stretch", label: "Stretch", hint: "Positions and sizes follow each axis separately." },
  { value: "center", label: "Center", hint: "Content keeps its size and stays centered." },
  { value: "none", label: "Page only", hint: "Only the page changes; content stays where it is." },
];

const UNITS: Unit[] = ["px", "mm", "in", "pt"];

function presetSize(p: PagePreset): string {
  if (p.physical) return `${p.physical.width} × ${p.physical.height} ${p.physical.unit}`;
  return `${p.width} × ${p.height} px`;
}

export function ResizePageDialog({
  editor,
  props,
  close,
}: SlotProps & { props: Record<string, unknown>; close: () => void }) {
  const design = useEditorStore((s) => s.doc.design);
  const pageId =
    (typeof props.pageId === "string" ? props.pageId : null) ?? editor.getState().pageId;
  const page = pageId && design?.nodes[pageId]?.type === "page" ? design.nodes[pageId] : null;
  const pageCount = design ? listPages(design).length : 1;
  const [category, setCategory] = useState<PresetCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [unit, setUnit] = useState<Unit>(page && "unit" in page ? page.unit : "px");
  const [size, setSize] = useState(() => {
    // The inspector opens the dialog with the width or height the user typed.
    const w = typeof props.width === "number" && props.width > 0 ? props.width : undefined;
    const h = typeof props.height === "number" && props.height > 0 ? props.height : undefined;
    return { width: w ?? page?.width ?? 1080, height: h ?? page?.height ?? 1080 };
  });
  const [locked, setLocked] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<ResizeStrategy>("scale");
  const [scope, setScope] = useState<"page" | "all">("page");

  const presets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PAGE_PRESETS.filter(
      (p) =>
        (category === "all" || p.category === category) &&
        (!q || `${p.label} ${p.platform ?? ""} ${p.kind}`.toLowerCase().includes(q)),
    );
  }, [category, query]);

  const display = (px: number) => Math.round(fromPx(px, unit) * 100) / 100;
  const setDim = (dim: "width" | "height", value: number) => {
    const px = Math.max(1, Math.min(100_000, toPx(value, unit)));
    setPreset(null);
    setSize((s) => {
      if (!locked) return { ...s, [dim]: px };
      const ratio = s.width / Math.max(s.height, 1);
      return dim === "width"
        ? { width: px, height: px / ratio }
        : { width: px * ratio, height: px };
    });
  };

  const apply = async () => {
    if (!pageId) return;
    const targetIds: Id[] =
      scope === "all" && design ? listPages(design).map((p) => p.id) : [pageId];
    const width = Math.round(size.width * 100) / 100;
    const height = Math.round(size.height * 100) / 100;
    await editor.apply(
      (d) => {
        let current = d;
        const ops: Op[] = [];
        for (const id of targetIds) {
          const tx = resizePage(current, id, { width, height }, { strategy, unit });
          ops.push(...tx.ops);
          current = applyTransaction(current, tx).design;
        }
        return ops;
      },
      { label: scope === "all" ? "Resize all pages" : "Resize page" },
    );
    editor.telemetry("page_resized", { strategy, scope, preset });
    close();
    requestAnimationFrame(() => editor.engine.fit());
  };

  const strategyHint = STRATEGIES.find((s) => s.value === strategy)?.hint;
  const unchanged =
    page && Math.abs(page.width - size.width) < 0.01 && Math.abs(page.height - size.height) < 0.01;

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size="lg" className="flex max-h-[min(720px,90dvh)] flex-col">
        <DialogHeader>
          <DialogTitle>
            resize <em className="text-accent">page</em>
          </DialogTitle>
          <DialogDescription>
            Pick a format or enter a size.{" "}
            {page ? `Now ${Math.round(page.width)} × ${Math.round(page.height)} px.` : null}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <div className="flex shrink-0 flex-col gap-2">
            <SearchField
              value={query}
              onChange={setQuery}
              label="Search formats"
              placeholder="Search formats (Instagram story, A4, slide…)"
            />
            <ChipRow
              label="Format category"
              value={category}
              onChange={setCategory}
              options={CATEGORIES}
            />
          </div>
          <div
            role="listbox"
            aria-label="Formats"
            className="-mx-1 grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-1 overflow-y-auto px-1 sm:grid-cols-2"
          >
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={preset === p.id}
                onClick={() => {
                  setPreset(p.id);
                  setSize({ width: p.width, height: p.height });
                  setUnit(p.unit);
                }}
                className={cn(
                  "flex items-center gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  preset === p.id
                    ? "border-accent/60 bg-accent-tint"
                    : "border-transparent hover:border-line-subtle hover:bg-fg/4",
                )}
              >
                <span className="grid size-9 shrink-0 place-items-center">
                  <span
                    className={cn(
                      "rounded-[2px] border",
                      preset === p.id ? "border-accent bg-accent-tint" : "border-fg-muted/60",
                    )}
                    style={{
                      width: p.width >= p.height ? 30 : Math.max(8, (30 * p.width) / p.height),
                      height: p.height >= p.width ? 30 : Math.max(8, (30 * p.height) / p.width),
                    }}
                  />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-fg">{p.label}</span>
                  <span className="text-2xs text-fg-muted tabular-nums">{presetSize(p)}</span>
                </span>
              </button>
            ))}
            {presets.length === 0 ? (
              <p className="col-span-full py-6 text-center text-xs text-fg-muted">
                No formats match “{query}”.
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col gap-3 border-t border-line-subtle pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <NumberField
                label="W"
                aria-label="Width"
                value={display(size.width)}
                min={display(1)}
                step={unit === "px" ? 1 : 0.1}
                onChangeEnd={(v) => setDim("width", v)}
                className="w-28"
              />
              <IconButton
                label={locked ? "Unlock aspect ratio" : "Lock aspect ratio"}
                size="sm"
                variant="ghost"
                active={locked}
                onClick={() => setLocked((l) => !l)}
              >
                {locked ? <Link2 /> : <Link2Off />}
              </IconButton>
              <NumberField
                label="H"
                aria-label="Height"
                value={display(size.height)}
                min={display(1)}
                step={unit === "px" ? 1 : 0.1}
                onChangeEnd={(v) => setDim("height", v)}
                className="w-28"
              />
              <Select<Unit>
                aria-label="Unit"
                size="sm"
                value={unit}
                onValueChange={setUnit}
                options={UNITS.map((u) => ({ value: u, label: u }))}
                className="w-20"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-secondary">Content</span>
              <SegmentedControl<ResizeStrategy>
                size="sm"
                fullWidth
                aria-label="How content follows"
                value={strategy}
                onValueChange={setStrategy}
                options={STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
              />
              <p className="text-2xs text-fg-muted">{strategyHint}</p>
            </div>
          </div>
        </DialogBody>
        <DialogFooter className="justify-between">
          {pageCount > 1 ? (
            <SegmentedControl<"page" | "all">
              size="sm"
              aria-label="Pages to resize"
              value={scope}
              onValueChange={setScope}
              options={[
                { value: "page", label: "This page" },
                { value: "all", label: `All ${pageCount} pages` },
              ]}
            />
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!editor.canEdit || (!!unchanged && scope === "page")}
              onClick={() => void apply()}
            >
              Resize
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
