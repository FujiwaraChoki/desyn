import { toast } from "@desyn/ui";
import { createStore, type StoreApi } from "zustand/vanilla";
import { errorMessage } from "../collab/live.ts";
import type { EditorController } from "../controller.ts";
import type { ExportBackend, ExportJob } from "./backend.ts";
import { downloadUrl, type ExportedFile, saveExport } from "./download.ts";
import {
  type ExportOptions,
  type ExportPlan,
  emailsWhenReady,
  engineRequests,
  outputFileNames,
  safeFileName,
  serverRequest,
} from "./options.ts";

/**
 * Running exports. Browser exports render page by page with the engine and save one file (or a zip); server
 * exports queue an `exports.request` job, whose status the dialog and a root tracker follow (the tracker keeps
 * following after the dialog closes, saves the result once and shows a toast).
 */

export interface TrackedJob {
  id: string;
  label: string;
  startedAt: number;
  job: ExportJob | null;
  /** The result was saved (or offered) once. */
  delivered: boolean;
  notify: boolean;
}

export interface ExportState {
  jobs: Record<string, TrackedJob>;
}

export interface ExportServices {
  backend: ExportBackend | null;
  store: StoreApi<ExportState>;
}

const registry = new WeakMap<EditorController, ExportServices>();

export function attachExport(
  editor: EditorController,
  backend: ExportBackend | null,
): ExportServices {
  const existing = registry.get(editor);
  if (existing) return existing;
  const services: ExportServices = {
    backend,
    store: createStore<ExportState>()(() => ({ jobs: {} })),
  };
  registry.set(editor, services);
  return services;
}

export function detachExport(editor: EditorController): void {
  registry.delete(editor);
}

export function exportOf(editor: EditorController): ExportServices | null {
  return registry.get(editor) ?? null;
}

/** Renders an export in the browser and saves it. Resolves to the produced files. */
export async function runBrowserExport(
  editor: EditorController,
  plan: ExportPlan,
  options: ExportOptions,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ExportedFile[]> {
  const requests = engineRequests(plan, options);
  const designName = editor.design?.name ?? "design";
  const names = outputFileNames(plan, designName);
  const files: ExportedFile[] = [];
  onProgress(0, requests.length);
  for (const [i, req] of requests.entries()) {
    if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
    const { bytes, info } = await editor.engine.export(req);
    files.push({
      name: names[i] ?? `${safeFileName(designName)}.${plan.format.extension}`,
      bytes,
      mime: info.mime,
    });
    if (info.missingAssets.length > 0 || info.missingFonts.length > 0) {
      editor.telemetry("export_missing_resources", {
        assets: info.missingAssets.length,
        fonts: info.missingFonts.length,
      });
    }
    onProgress(i + 1, requests.length);
  }
  if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
  saveExport(
    files,
    `${safeFileName(designName)} (${plan.format.label}).zip`,
    plan.format.id === "svg",
  );
  return files;
}

/** Queues a server export and starts tracking it. Resolves to the job id. */
export async function startServerExport(
  editor: EditorController,
  plan: ExportPlan,
  options: ExportOptions,
): Promise<string> {
  const services = exportOf(editor);
  if (!services?.backend) throw new Error("Exports need the Desyn server.");
  const total = editor.design
    ? ((editor.design.nodes.root as { children?: string[] }).children ?? []).length
    : 0;
  const args = serverRequest(plan, options, total);
  const id = await services.backend.request(args);
  services.store.setState((s) => ({
    jobs: {
      ...s.jobs,
      [id]: {
        id,
        label: `${plan.format.label} · ${plan.pageIds.length} ${plan.pageIds.length === 1 ? "page" : "pages"}`,
        startedAt: Date.now(),
        job: null,
        delivered: false,
        notify: emailsWhenReady(plan, options),
      },
    },
  }));
  return id;
}

/** Saves the files of a finished job (one link per file; browsers keep them as separate downloads). */
export function deliverJob(job: ExportJob): void {
  const files = job.files.filter((f) => typeof f.url === "string" && f.url.length > 0);
  for (const [i, f] of files.entries()) {
    // Stagger: some browsers drop simultaneous programmatic downloads.
    setTimeout(() => void downloadUrl(f.url as string, f.fileName), i * 400);
  }
}

/** Follows tracked jobs: status into the store, one delivery + toast when they finish. */
export function trackJobs(editor: EditorController): () => void {
  const services = exportOf(editor);
  if (!services?.backend) return () => {};
  const backend = services.backend;
  const subs = new Map<string, () => void>();
  const sync = () => {
    const { jobs } = services.store.getState();
    for (const id of Object.keys(jobs)) {
      if (subs.has(id)) continue;
      // Reserve the slot first: a cached status arrives synchronously and re-enters `sync`.
      subs.set(id, () => {});
      const toastId = `export-${id}`;
      const off = backend.status(id).subscribe(
        (job) => {
          const tracked = services.store.getState().jobs[id];
          if (!tracked) return;
          const finished =
            job.status === "ready" || job.status === "failed" || job.status === "expired";
          services.store.setState((s) => ({
            jobs: {
              ...s.jobs,
              [id]: { ...tracked, job, delivered: tracked.delivered || finished },
            },
          }));
          if (!finished) {
            toast(`Rendering ${tracked.label}`, {
              id: toastId,
              variant: "loading",
              description:
                job.status === "queued"
                  ? "Waiting for the renderer…"
                  : tracked.notify
                    ? "We'll e-mail you a link when it's ready."
                    : "This can take a moment for many pages or video.",
            });
            return;
          }
          if (tracked.delivered) return;
          if (job.status === "ready") {
            deliverJob(job);
            const bytes = job.files.reduce((n, f) => n + f.bytes, 0);
            toast.success("Export ready", {
              id: toastId,
              description: `${job.files.length} ${job.files.length === 1 ? "file" : "files"}, ${(bytes / 1024 / 1024).toFixed(1)} MB. Downloading now.`,
              action: { label: "Download again", onClick: () => deliverJob(job) },
              duration: 12_000,
            });
            editor.telemetry("export_done", {
              route: "server",
              format: job.format,
              files: job.files.length,
            });
          } else {
            toast.error("Export failed", {
              id: toastId,
              description: job.error ?? "The renderer could not finish this export.",
              duration: 12_000,
            });
            editor.telemetry("export_failed", { route: "server", format: job.format });
          }
        },
        (e) => {
          toast.error("Lost track of the export", { id: toastId, description: errorMessage(e) });
        },
      );
      subs.set(id, off);
    }
  };
  sync();
  const offStore = services.store.subscribe(sync);
  return () => {
    offStore();
    for (const off of subs.values()) off();
    subs.clear();
  };
}
