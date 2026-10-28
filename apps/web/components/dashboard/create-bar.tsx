"use client";

import { fromPx, getPreset, PAGE_PRESETS, type PagePreset, type Unit } from "@desyn/schema";
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
  Field,
  Input,
  NumberField,
  ScrollArea,
  Select,
  SunSpinner,
} from "@desyn/ui";
import { LayoutGrid, Plus, Search } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useCreateDesign } from "@/components/designs/use-create-design";
import { Rich } from "@/components/rich";
import type { Id } from "@/lib/convex-api";
import { formatSize } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { FEATURED_PRESETS, WARM } from "./featured-presets";

function presetSizeLabel(p: PagePreset): string {
  if (p.physical) return `${p.physical.width} × ${p.physical.height} ${p.physical.unit}`;
  return formatSize(p.width, p.height, "px");
}

/** A small page silhouette at the preset's aspect ratio. */
function PresetShape({
  preset,
  color,
  busy,
}: {
  preset: PagePreset;
  color: string;
  busy?: boolean;
}) {
  const ratio = preset.width / preset.height;
  const box = 52;
  const w = ratio >= 1 ? box : box * ratio;
  const h = ratio >= 1 ? box / ratio : box;
  return (
    <span className="grid size-16 place-items-center">
      <span
        className="relative grid place-items-center rounded-[4px] shadow-[0_10px_24px_-10px_rgb(0_0_0/0.6)] transition-transform duration-300 ease-out group-hover:-translate-y-0.5 group-hover:scale-105"
        style={{
          width: Math.max(10, w),
          height: Math.max(10, h),
          background: `linear-gradient(150deg, ${color}, color-mix(in oklab, ${color} 55%, #1a1205))`,
        }}
      >
        {busy ? <SunSpinner size={16} className="text-[#1a1205]" /> : null}
      </span>
    </span>
  );
}

export function CreateBar({ folderId }: { folderId?: Id<"folders"> | null }) {
  const t = useT();
  const { createDesign, pending } = useCreateDesign();
  const [customOpen, setCustomOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const featured = FEATURED_PRESETS.map((f) => ({ ...f, preset: getPreset(f.id) })).filter(
    (f): f is typeof f & { preset: PagePreset } => Boolean(f.preset),
  );

  const start = (preset: PagePreset) =>
    createDesign(
      { kind: preset.kind, presetId: preset.id, folderId: folderId ?? null },
      { key: preset.id },
    );

  return (
    <section aria-label={t("dashboard.create.title")}>
      <div className="-mx-4 overflow-x-auto px-4 pb-2 scrollbar-none sm:-mx-1 sm:px-1">
        <ul className="flex gap-2">
          {featured.map((f, i) => (
            <li key={f.id}>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => start(f.preset)}
                className="group flex w-[116px] cursor-pointer flex-col items-center gap-1.5 rounded-[12px] px-1 pt-2 pb-2.5 text-center transition-colors hover:bg-fg/[0.05] focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-progress"
              >
                <PresetShape
                  preset={f.preset}
                  color={WARM[i % WARM.length] ?? "#FFB02E"}
                  busy={pending === f.id}
                />
                <span className="w-full truncate text-xs font-medium text-fg-secondary group-hover:text-fg">
                  {f.label}
                </span>
                <span className="w-full truncate text-[10px] text-fg-muted tabular-nums">
                  {presetSizeLabel(f.preset)}
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              className="group flex w-[116px] cursor-pointer flex-col items-center gap-1.5 rounded-[12px] px-1 pt-2 pb-2.5 text-center transition-colors hover:bg-fg/[0.05] focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="grid size-16 place-items-center">
                <span className="grid size-12 place-items-center rounded-[6px] bg-fg/6 text-fg-muted transition-colors group-hover:text-accent">
                  <Plus className="size-5" />
                </span>
              </span>
              <span className="text-xs font-medium text-fg-secondary group-hover:text-fg">
                {t("dashboard.create.customSize")}
              </span>
              <span className="text-[10px] text-fg-muted">px · mm · in</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => setAllOpen(true)}
              className="group flex w-[116px] cursor-pointer flex-col items-center gap-1.5 rounded-[12px] px-1 pt-2 pb-2.5 text-center transition-colors hover:bg-fg/[0.05] focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="grid size-16 place-items-center">
                <span className="grid size-12 place-items-center rounded-[6px] bg-fg/6 text-fg-muted transition-colors group-hover:text-accent">
                  <LayoutGrid className="size-5" />
                </span>
              </span>
              <span className="text-xs font-medium text-fg-secondary group-hover:text-fg">
                {t("dashboard.create.more")}
              </span>
              <span className="text-[10px] text-fg-muted">{PAGE_PRESETS.length}+</span>
            </button>
          </li>
        </ul>
      </div>
      <CustomSizeDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        onCreate={(size) =>
          createDesign({ kind: "custom", size, folderId: folderId ?? null }, { key: "custom" })
        }
      />
      <AllFormatsDialog
        open={allOpen}
        onOpenChange={setAllOpen}
        pending={pending}
        onPick={(preset) => start(preset)}
      />
    </section>
  );
}

const UNIT_OPTIONS: { value: Unit; label: string }[] = [
  { value: "px", label: "px" },
  { value: "mm", label: "mm" },
  { value: "in", label: "in" },
  { value: "pt", label: "pt" },
];

const PX_PER: Record<Unit, number> = { px: 1, mm: 96 / 25.4, in: 96, pt: 96 / 72 };

function CustomSizeDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (size: { width: number; height: number; unit: Unit }) => Promise<unknown>;
}) {
  const t = useT();
  const [unit, setUnit] = useState<Unit>("px");
  const [width, setWidth] = useState<number | null>(1080);
  const [height, setHeight] = useState<number | null>(1080);
  const [pending, setPending] = useState(false);
  const valid = width !== null && height !== null && width > 0 && height > 0;
  const pxW = valid ? width * PX_PER[unit] : 0;
  const pxH = valid ? height * PX_PER[unit] : 0;
  const inRange = valid && pxW >= 1 && pxH >= 1 && pxW <= 100_000 && pxH <= 100_000;

  const changeUnit = (next: Unit) => {
    // Keep the physical size when switching units.
    if (width !== null) setWidth(Math.round(fromPx(width * PX_PER[unit], next) * 100) / 100);
    if (height !== null) setHeight(Math.round(fromPx(height * PX_PER[unit], next) * 100) / 100);
    setUnit(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!inRange) return;
    setPending(true);
    await onCreate({
      width: Math.round(pxW * 100) / 100,
      height: Math.round(pxH * 100) / 100,
      unit,
    });
    setPending(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="rich-title">
              <Rich text={t("dashboard.create.customTitle")} />
            </DialogTitle>
            <DialogDescription>{t("dashboard.create.customBody")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="pb-5">
            <div className="grid grid-cols-[1fr_1fr_88px] items-end gap-3">
              <Field label={t("dashboard.create.width")}>
                <NumberField
                  value={width}
                  onChange={setWidth}
                  min={0.01}
                  max={100000}
                  step={1}
                  aria-label={t("dashboard.create.width")}
                />
              </Field>
              <Field label={t("dashboard.create.height")}>
                <NumberField
                  value={height}
                  onChange={setHeight}
                  min={0.01}
                  max={100000}
                  step={1}
                  aria-label={t("dashboard.create.height")}
                />
              </Field>
              <Field label={t("dashboard.create.unit")}>
                <Select
                  options={UNIT_OPTIONS}
                  value={unit}
                  onValueChange={changeUnit}
                  aria-label={t("dashboard.create.unit")}
                />
              </Field>
            </div>
            {valid && unit !== "px" ? (
              <p className="mt-3 text-xs text-fg-muted tabular-nums">
                {formatSize(Math.round(pxW), Math.round(pxH))}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={pending} disabled={!inRange}>
              {t("dashboard.create.createButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const CATEGORY_ORDER = ["social", "video", "presentation", "print", "web", "ads", "other"] as const;
const CATEGORY_LABEL: Record<string, string> = {
  social: "Social",
  video: "Video",
  presentation: "Presentations",
  print: "Print",
  web: "Web & email",
  ads: "Ads",
  other: "Other",
};

function AllFormatsDialog({
  open,
  onOpenChange,
  pending,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: string | null;
  onPick: (preset: PagePreset) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = PAGE_PRESETS.filter(
      (p) =>
        !q ||
        p.label.toLowerCase().includes(q) ||
        p.kind.includes(q) ||
        (p.platform ?? "").includes(q),
    );
    return CATEGORY_ORDER.map((c) => ({
      category: c,
      presets: matches.filter((p) => p.category === c),
    })).filter((g) => g.presets.length > 0);
  }, [query]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="h-[min(720px,calc(100dvh-32px))]">
        <DialogHeader>
          <DialogTitle>{t("dashboard.create.allFormats")}</DialogTitle>
          <Input
            className="mt-3"
            leading={<Search />}
            placeholder={t("dashboard.create.searchFormats")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("dashboard.create.searchFormats")}
            autoFocus
          />
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-6 px-6 pb-6">
            {groups.map((g) => (
              <section key={g.category}>
                <h3 className="mb-2 text-2xs font-medium text-fg-muted">
                  {CATEGORY_LABEL[g.category]}
                </h3>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1">
                  {g.presets.map((p, i) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => onPick(p)}
                        className={cn(
                          "group flex w-full cursor-pointer items-center gap-3 rounded-[10px] p-2 text-left transition-colors hover:bg-fg/[0.05] focus-visible:outline-2 focus-visible:outline-ring",
                          pending === p.id && "bg-accent-tint",
                        )}
                      >
                        <span className="scale-75">
                          <PresetShape
                            preset={p}
                            color={WARM[i % WARM.length] ?? "#FFB02E"}
                            busy={pending === p.id}
                          />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-fg">{p.label}</span>
                          <span className="block truncate text-2xs text-fg-muted tabular-nums">
                            {presetSizeLabel(p)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
