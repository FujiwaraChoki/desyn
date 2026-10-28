"use client";

import { pages as pagesOf } from "@desyn/doc-ops";
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  ProBadge,
  Progress,
  SegmentedControl,
  Select,
  Slider,
  Switch,
} from "@desyn/ui";
import {
  Clapperboard,
  Cloud,
  Download,
  FileImage,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  type LucideIcon,
  Mail,
  MonitorDown,
  Presentation,
  Printer,
  Shapes,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { errorCode, errorMessage } from "../collab/live.ts";
import type { ModalProps } from "../collab/ui.ts";
import { useEditor, useEditorStore } from "../context.tsx";
import { useExportFeatures } from "./features.ts";
import { type ExportFormat, FORMATS, type FormatInfo, isExportFormat } from "./formats.ts";
import {
  defaultExportOptions,
  type ExportContext,
  type ExportOptions,
  emailsWhenReady,
  FPS_CHOICES,
  formatBytes,
  planExport,
  snapFps,
} from "./options.ts";
import {
  deliverJob,
  type ExportState,
  exportOf,
  runBrowserExport,
  startServerExport,
} from "./run.ts";

const ICONS: Record<ExportFormat, LucideIcon> = {
  png: ImageIcon,
  jpeg: FileImage,
  webp: ImageIcon,
  svg: Shapes,
  pdf: FileText,
  "pdf-print": Printer,
  pptx: Presentation,
  gif: Clapperboard,
  mp4: Film,
};

const GROUPS: { id: FormatInfo["group"]; label: string }[] = [
  { id: "image", label: "Image" },
  { id: "document", label: "Document" },
  { id: "motion", label: "Motion" },
];

const SCALES = [0.5, 1, 2, 3, 4];

const PREFS_KEY = "desyn-export-options";

function loadPrefs(): Partial<ExportOptions> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<ExportOptions>) : {};
  } catch {
    return {};
  }
}

function savePrefs(o: ExportOptions): void {
  try {
    const { format, sizeMode, scale, width, quality, transparent, pdf, fps } = o;
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ format, sizeMode, scale, width, quality, transparent, pdf, fps }),
    );
  } catch {
    // Storage blocked: the dialog just starts from the defaults next time.
  }
}

type RunState =
  | { kind: "idle" }
  | { kind: "browser"; done: number; total: number }
  | { kind: "server"; jobId: string }
  | { kind: "done"; files: number; bytes: number }
  | { kind: "error"; message: string };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

function FormatCard({
  info,
  selected,
  locked,
  onSelect,
}: {
  info: FormatInfo;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
}) {
  const Icon = ICONS[info.id];
  return (
    // biome-ignore lint/a11y/useSemanticElements: styled radio card inside a radiogroup
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      // Roving focus: only the chosen format is a tab stop (the dialog opens with focus on it).
      tabIndex={selected ? 0 : -1}
      data-format={info.id}
      onClick={onSelect}
      className={cn(
        "group flex items-center gap-3 rounded-card px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-200 focus-visible:outline-2 focus-visible:outline-ring",
        selected ? "bg-accent-tint" : "bg-surface-2/40 hover:bg-surface-2",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-[8px] transition-colors",
          selected ? "bg-accent-solid text-accent-ink" : "bg-fg/6 text-fg-secondary",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
          {info.label}
          {locked ? <ProBadge /> : null}
        </span>
        <span className="block truncate text-[11px] text-fg-muted">{info.description}</span>
      </span>
    </button>
  );
}

function PagePicker({
  pages,
  selected,
  onChange,
}: {
  pages: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const set = new Set(selected);
  return (
    <div className="max-h-40 overflow-y-auto rounded-card bg-surface-2/40 p-1">
      {pages.map((p, i) => (
        <div
          key={p.id}
          className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-fg/[0.04]"
        >
          <Checkbox
            id={`export-page-${p.id}`}
            checked={set.has(p.id)}
            onCheckedChange={(c) => {
              const next = new Set(set);
              if (c === true) next.add(p.id);
              else next.delete(p.id);
              onChange(pages.filter((x) => next.has(x.id)).map((x) => x.id));
            }}
          />
          <label
            htmlFor={`export-page-${p.id}`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
          >
            <span className="w-6 text-right text-[11px] tabular-nums text-fg-muted">{i + 1}</span>
            <span className="truncate text-fg">{p.name || `Page ${i + 1}`}</span>
          </label>
        </div>
      ))}
    </div>
  );
}

/** Export dialog (modal `export`, mod+shift+e): every format, pages, size, quality, background, print options. */
export function ExportDialog({ close, props }: ModalProps) {
  const editor = useEditor();
  const services = exportOf(editor);
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const engineReady = useEditorStore((s) => s.engine.status === "ready");
  const signedIn = useEditorStore((s) => s.user !== null);
  const { features, known } = useExportFeatures();
  const [options, setOptions] = useState<ExportOptions>(() => {
    const initial = props.format as ExportFormat | undefined;
    const merged = { ...defaultExportOptions(), ...loadPrefs() };
    if (!isExportFormat(merged.format)) merged.format = "png";
    if (initial && isExportFormat(initial)) merged.format = initial;
    if (props.pages === "current") merged.pages = "current";
    // Saved preferences may hold another format's frame rate.
    merged.fps = snapFps(merged.format, merged.fps);
    return merged;
  });
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  const jobs = useStore(services?.store ?? exportFallbackStore, (s) => s.jobs);

  const pageInfos = useMemo(
    () =>
      design
        ? pagesOf(design).map((p) => ({
            id: p.id,
            name: p.name,
            width: p.width,
            height: p.height,
            bleed: p.bleed ?? 0,
          }))
        : [],
    [design],
  );
  const ctx: ExportContext = {
    designName: design?.name ?? "design",
    pages: pageInfos,
    currentPageId: pageId,
    features: known
      ? features
      : Object.fromEntries(FORMATS.flatMap((f) => f.features).map((k) => [k, true])),
    engineReady,
    signedIn,
    serverAvailable: !!services?.backend,
  };
  const plan = planExport(options, ctx);
  const f = plan.format;
  const mailsAnyway = emailsWhenReady(plan, { ...options, notify: false });
  const set = (patch: Partial<ExportOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const busy =
    run.kind === "browser" || (run.kind === "server" && !isFinished(jobs[run.jobId]?.job?.status));

  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (!plan.ok || busy) return;
    savePrefs(options);
    editor.telemetry("export_started", {
      format: f.id,
      route: plan.route,
      pages: plan.pageIds.length,
    });
    if (plan.route === "browser") {
      const ac = new AbortController();
      abort.current = ac;
      setRun({ kind: "browser", done: 0, total: plan.outputs.length });
      try {
        const files = await runBrowserExport(
          editor,
          plan,
          options,
          (done, total) => setRun({ kind: "browser", done, total }),
          ac.signal,
        );
        setRun({
          kind: "done",
          files: files.length,
          bytes: files.reduce((n, x) => n + x.bytes.length, 0),
        });
        editor.telemetry("export_done", { route: "browser", format: f.id, files: files.length });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          setRun({ kind: "idle" });
          return;
        }
        setRun({ kind: "error", message: errorMessage(e) });
        editor.telemetry("export_failed", { route: "browser", format: f.id });
      }
      return;
    }
    try {
      const jobId = await startServerExport(editor, plan, options);
      setRun({ kind: "server", jobId });
    } catch (e) {
      setRun({
        kind: "error",
        message:
          errorCode(e) === "NOT_CONFIGURED"
            ? "Server rendering is not set up on this deployment."
            : errorMessage(e),
      });
    }
  };

  const tracked = run.kind === "server" ? jobs[run.jobId] : undefined;
  const job = tracked?.job ?? null;

  const outputsSummary = (() => {
    const o = plan.outputs[0];
    if (!o) return "";
    const files = f.perPage ? plan.outputs.length : 1;
    const size =
      f.wire === "svg" || f.wire === "pdf" || f.wire === "pptx"
        ? ""
        : ` · ${o.width} × ${o.height} px`;
    return `${files} ${files === 1 ? "file" : "files"}${files > 1 && f.perPage ? " in a zip" : ""}${size}`;
  })();

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent size="xl" className="max-h-[min(720px,calc(100dvh-32px))]">
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Formats */}
          <div className="flex min-h-0 shrink-0 flex-col gap-4 border-line-subtle p-5 pb-0 max-md:border-b md:w-[300px] md:border-r">
            <div className="pr-8 md:pr-0">
              <DialogTitle>
                export <em className="text-accent">design</em>
              </DialogTitle>
              <DialogDescription className="mt-1">
                Pick a format, then fine-tune it.
              </DialogDescription>
            </div>
            <div
              role="radiogroup"
              aria-label="Format"
              onKeyDown={(e) => {
                const step =
                  e.key === "ArrowDown" || e.key === "ArrowRight"
                    ? 1
                    : e.key === "ArrowUp" || e.key === "ArrowLeft"
                      ? -1
                      : 0;
                if (step === 0) return;
                e.preventDefault();
                const order = GROUPS.flatMap((g) => FORMATS.filter((x) => x.group === g.id));
                const at = order.findIndex((x) => x.id === options.format);
                const nextFormat = order[(at + step + order.length) % order.length];
                if (!nextFormat) return;
                set({ format: nextFormat.id, fps: snapFps(nextFormat.id, options.fps) });
                setRun({ kind: "idle" });
                e.currentTarget
                  .querySelector<HTMLElement>(`[data-format="${nextFormat.id}"]`)
                  ?.focus();
              }}
              className="-mx-5 flex min-h-0 flex-col gap-4 px-5 pb-5 max-md:max-h-56 max-md:overflow-y-auto md:flex-1 md:overflow-y-auto"
            >
              {GROUPS.map((g) => (
                <div key={g.id} className="flex flex-col gap-1.5">
                  <p className="text-[11px] font-medium text-fg-muted">{g.label}</p>
                  <div className="grid grid-cols-2 gap-1.5 md:grid-cols-1">
                    {FORMATS.filter((x) => x.group === g.id).map((x) => (
                      <FormatCard
                        key={x.id}
                        info={x}
                        selected={options.format === x.id}
                        locked={known && x.features.some((k) => features[k] !== true)}
                        onSelect={() => {
                          set({ format: x.id, fps: snapFps(x.id, options.fps) });
                          setRun({ kind: "idle" });
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Options */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5 pt-3 md:pt-5">
              <Section title="Pages">
                <SegmentedControl
                  size="sm"
                  className="self-start"
                  aria-label="Pages"
                  value={
                    options.pages === "all"
                      ? "all"
                      : options.pages === "current"
                        ? "current"
                        : "custom"
                  }
                  onValueChange={(v) =>
                    set({
                      pages: v === "custom" ? (pageId ? [pageId] : []) : (v as "all" | "current"),
                    })
                  }
                  options={[
                    { value: "all", label: `All (${pageInfos.length})` },
                    { value: "current", label: "Current page" },
                    { value: "custom", label: "Choose…" },
                  ]}
                />
                {Array.isArray(options.pages) ? (
                  <PagePicker
                    pages={pageInfos}
                    selected={options.pages}
                    onChange={(ids) => set({ pages: ids })}
                  />
                ) : null}
                {plan.errors.pages ? (
                  <p className="text-xs text-danger">{plan.errors.pages}</p>
                ) : null}
              </Section>

              {f.supports.scale ? (
                <Section title="Size">
                  <div className="flex flex-wrap items-center gap-2">
                    <SegmentedControl
                      size="sm"
                      aria-label="Size by"
                      value={options.sizeMode}
                      onValueChange={(sizeMode) => set({ sizeMode })}
                      options={[
                        { value: "scale", label: "Scale" },
                        { value: "width", label: "Width" },
                      ]}
                    />
                    {options.sizeMode === "scale" ? (
                      <SegmentedControl
                        size="sm"
                        aria-label="Scale"
                        value={SCALES.includes(options.scale) ? String(options.scale) : ""}
                        onValueChange={(v) => set({ scale: Number(v) })}
                        options={SCALES.map((s) => ({ value: String(s), label: `${s}×` }))}
                      />
                    ) : (
                      <Input
                        size="sm"
                        type="number"
                        min={16}
                        max={16384}
                        value={Number.isFinite(options.width) ? options.width : ""}
                        onChange={(e) => set({ width: Math.round(Number(e.target.value)) })}
                        aria-label="Width in pixels"
                        trailing={<span className="text-xs">px</span>}
                        className="w-32"
                      />
                    )}
                  </div>
                  {plan.errors.scale || plan.errors.width ? (
                    <p className="text-xs text-danger">{plan.errors.scale ?? plan.errors.width}</p>
                  ) : plan.outputs[0] ? (
                    <p className="text-xs text-fg-muted tabular-nums">
                      {plan.outputs[0].width} × {plan.outputs[0].height} px
                      {plan.outputs.some(
                        (o) =>
                          o.width !== plan.outputs[0]?.width ||
                          o.height !== plan.outputs[0]?.height,
                      )
                        ? " (first page)"
                        : ""}
                    </p>
                  ) : null}
                </Section>
              ) : null}

              {f.supports.quality ? (
                <Section title="Quality">
                  <div className="flex items-center gap-3">
                    <Slider
                      aria-label="Quality"
                      min={1}
                      max={100}
                      step={1}
                      value={[options.quality]}
                      onValueChange={([q]) => set({ quality: q ?? options.quality })}
                      className="flex-1"
                    />
                    <span className="w-10 text-right text-xs tabular-nums text-fg-secondary">
                      {options.quality}
                    </span>
                  </div>
                  <p className="text-xs text-fg-muted">
                    {options.quality >= 90
                      ? "Best quality, larger files."
                      : options.quality >= 70
                        ? "Balanced: hard to tell apart, much smaller."
                        : "Smallest files; visible artifacts on detail."}
                  </p>
                </Section>
              ) : null}

              {f.supports.transparent ? (
                <Section title="Background">
                  <Switch
                    size="sm"
                    checked={options.transparent}
                    onCheckedChange={(transparent) => set({ transparent })}
                    label="Transparent background"
                    description="Leave out the page background fill."
                  />
                </Section>
              ) : null}

              {f.supports.compression ? (
                <Section title="Compression">
                  <Select
                    size="sm"
                    aria-label="Image resolution"
                    value={String(options.pdf.dpi)}
                    onValueChange={(v) => set({ pdf: { ...options.pdf, dpi: Number(v) } })}
                    options={[
                      {
                        value: "300",
                        label: "High quality",
                        description: "300 dpi images and effects",
                      },
                      { value: "150", label: "Balanced", description: "150 dpi: good on screens" },
                      { value: "96", label: "Small file", description: "96 dpi: quick to share" },
                    ]}
                    className="w-56"
                  />
                  <p className="text-xs text-fg-muted">
                    Text and shapes stay vector at every setting.
                  </p>
                </Section>
              ) : null}

              {f.supports.bleed ? (
                <Section title="Print">
                  <div className="flex flex-col gap-2.5">
                    <Switch
                      size="sm"
                      checked={options.pdf.bleed}
                      onCheckedChange={(bleed) => set({ pdf: { ...options.pdf, bleed } })}
                      label="Bleed"
                      description="Extend the background past the trim line by the page's bleed."
                    />
                    <Switch
                      size="sm"
                      checked={options.pdf.cropMarks}
                      onCheckedChange={(cropMarks) => set({ pdf: { ...options.pdf, cropMarks } })}
                      label="Crop marks"
                      description="Trim marks at the corners for the print shop."
                    />
                    <Switch
                      size="sm"
                      checked={options.pdf.cmyk}
                      onCheckedChange={(cmyk) => set({ pdf: { ...options.pdf, cmyk } })}
                      label="CMYK colors"
                      description="Convert colors for four-color printing."
                    />
                  </div>
                </Section>
              ) : null}

              {f.supports.fps ? (
                <Section title="Frame rate">
                  <SegmentedControl
                    size="sm"
                    className="self-start"
                    aria-label="Frame rate"
                    value={String(options.fps)}
                    onValueChange={(v) => set({ fps: Number(v) })}
                    options={(FPS_CHOICES[f.id] ?? []).map((n) => ({
                      value: String(n),
                      label: `${n} fps`,
                    }))}
                  />
                  <p className="text-xs text-fg-muted">
                    Pages play for their duration with their animations and transitions.
                  </p>
                </Section>
              ) : null}

              {plan.route === "server" && !plan.errors.route ? (
                <Section title="Delivery">
                  <Switch
                    size="sm"
                    checked={mailsAnyway || options.notify}
                    disabled={mailsAnyway}
                    onCheckedChange={(notify) => set({ notify })}
                    label="E-mail me a link when it's ready"
                    description={
                      mailsAnyway
                        ? "Large exports, decks and videos always send one."
                        : "The download also starts here when it's done."
                    }
                  />
                </Section>
              ) : null}

              {plan.warnings.map((w) => (
                <p key={w} className="flex items-start gap-1.5 text-xs text-fg-secondary">
                  <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
                  {w}
                </p>
              ))}
            </div>

            {/* Footer: route, progress, action */}
            <div className="flex flex-col gap-3 border-t border-line-subtle bg-fg/[0.02] px-5 py-4">
              {run.kind === "browser" ? (
                <div className="flex flex-col gap-1.5">
                  <Progress
                    value={run.total > 0 ? (run.done / run.total) * 100 : null}
                    label="Export progress"
                  />
                  <p className="text-xs text-fg-muted tabular-nums">
                    Rendering {Math.min(run.done + 1, run.total)} of {run.total}…
                  </p>
                </div>
              ) : run.kind === "server" ? (
                <div className="flex flex-col gap-1.5">
                  <Progress value={job?.status === "ready" ? 100 : null} label="Export progress" />
                  <p className="text-xs text-fg-muted">
                    {!job || job.status === "queued"
                      ? "Queued on the renderer…"
                      : job.status === "rendering"
                        ? "Rendering on Desyn's servers. You can close this dialog; the download starts when it's done."
                        : job.status === "ready"
                          ? `Ready: ${job.files.length} ${job.files.length === 1 ? "file" : "files"}, ${formatBytes(job.files.reduce((n, x) => n + x.bytes, 0))}.`
                          : (job.error ?? "The export failed.")}
                  </p>
                </div>
              ) : run.kind === "done" ? (
                <p className="text-xs text-success">
                  Saved {run.files} {run.files === 1 ? "file" : "files"} ({formatBytes(run.bytes)}).
                </p>
              ) : run.kind === "error" ? (
                <p className="text-xs text-danger">{run.message}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-muted">
                  {plan.errors.format || plan.errors.route ? (
                    <span className="flex items-center gap-1.5 text-fg-secondary">
                      {plan.locked.length > 0 ? (
                        <ProBadge />
                      ) : (
                        <TriangleAlert className="size-3.5 text-warning" />
                      )}
                      {plan.errors.format ?? plan.errors.route}
                    </span>
                  ) : plan.route === "browser" ? (
                    <>
                      <MonitorDown className="size-3.5 shrink-0" />
                      <span className="truncate">{outputsSummary} · rendered in your browser</span>
                    </>
                  ) : (
                    <>
                      <Cloud className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {outputsSummary} · {plan.serverReason}
                      </span>
                    </>
                  )}
                </p>
                {job?.status === "ready" ? (
                  <Button
                    variant="secondary"
                    size="md"
                    leadingIcon={<Download />}
                    onClick={() => deliverJob(job)}
                  >
                    Download again
                  </Button>
                ) : null}
                {run.kind === "browser" ? (
                  <Button variant="ghost" onClick={() => abort.current?.abort()}>
                    Cancel
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={close}>
                    {run.kind === "server" && !isFinished(job?.status) ? "Close" : "Done"}
                  </Button>
                )}
                <Button
                  variant="primary"
                  leadingIcon={
                    plan.route === "server" ? (
                      emailsWhenReady(plan, options) ? (
                        <Mail />
                      ) : (
                        <Layers />
                      )
                    ) : (
                      <Download />
                    )
                  }
                  disabled={!plan.ok || busy}
                  loading={busy}
                  onClick={() => void start()}
                >
                  {plan.route === "server" ? "Start export" : `Download ${f.label}`}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function isFinished(status: string | undefined): boolean {
  return status === "ready" || status === "failed" || status === "expired";
}

/** Store used when the host has no export backend (keeps hook order stable). */
const exportFallbackStore = createStore<ExportState>()(() => ({ jobs: {} }));
