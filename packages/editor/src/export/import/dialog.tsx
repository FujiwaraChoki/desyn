"use client";

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
  Progress,
} from "@desyn/ui";
import {
  CheckCircle2,
  FileCode2,
  FileImage,
  FileText,
  FileUp,
  Presentation,
  Shapes,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../collab/live.ts";
import type { ModalProps } from "../../collab/ui.ts";
import { useEditor, useEditorStore } from "../../context.tsx";
import {
  IMPORT_ACCEPT,
  type ImportItem,
  type ImportKind,
  importFile,
  importKindOf,
} from "./run.ts";

const KIND_ICON: Record<ImportKind, typeof FileImage> = {
  image: FileImage,
  svg: Shapes,
  pdf: FileText,
  pptx: Presentation,
  design: FileCode2,
};

const KIND_LABEL: Record<ImportKind, string> = {
  image: "Image",
  svg: "SVG",
  pdf: "PDF",
  pptx: "PowerPoint",
  design: "Desyn design",
};

let counter = 0;

/** Import dialog (modal `import`): drop or pick files; each runs as one undoable step with progress. */
export function ImportDialog({ close, props }: ModalProps) {
  const editor = useEditor();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [items, setItems] = useState<ImportItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef(new AbortController());
  const running = items.some((i) => i.status === "working" || i.status === "waiting");
  const queue = useRef<Promise<void>>(Promise.resolve());

  const update = (id: string, patch: Partial<ImportItem>) =>
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const add = (files: File[]) => {
    if (!canEdit || files.length === 0) return;
    const next = files.map<ImportItem & { file: File }>((file) => ({
      id: `imp${++counter}`,
      name: file.name,
      kind: importKindOf(file),
      status: "waiting",
      done: 0,
      total: 0,
      message: null,
      file,
    }));
    setItems((list) => [...list, ...next.map(({ file: _f, ...rest }) => rest)]);
    for (const item of next) {
      queue.current = queue.current.then(async () => {
        if (abort.current.signal.aborted) return;
        if (!item.kind) {
          update(item.id, { status: "error", message: "Unsupported file type." });
          return;
        }
        update(item.id, { status: "working" });
        try {
          const w = await importFile(editor, item.file, {
            signal: abort.current.signal,
            onUpdate: (patch) => update(item.id, patch),
          });
          update(item.id, { status: "done", message: null });
          if (w.length > 0) setWarnings((prev) => [...new Set([...prev, ...w])]);
          editor.telemetry("import_done", { kind: item.kind });
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          update(item.id, { status: "error", message: errorMessage(e) });
          editor.telemetry("import_failed", { kind: item.kind });
        }
      });
    }
  };

  // Files handed over by the canvas drop target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the files passed when the dialog opens
  useEffect(() => {
    const files = props.files;
    if (Array.isArray(files) && files.every((f) => f instanceof File)) add(files as File[]);
  }, []);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    add([...e.dataTransfer.files]);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            import <em className="text-accent">files</em>
          </DialogTitle>
          <DialogDescription>
            PDF and PowerPoint add pages, .desyn and JSON add their pages, images and SVG land on
            this page.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target; the button inside opens the picker */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-col items-center gap-3 rounded-panel px-6 py-8 text-center transition-colors duration-200",
              over ? "bg-accent/8 ring-1 ring-accent/60" : "bg-fg/[0.04]",
            )}
          >
            <span className="grid size-12 place-items-center rounded-full bg-accent-tint text-accent">
              <FileUp className="size-5" />
            </span>
            <p className="font-serif text-xl text-fg">
              drop files <em className="text-accent">here</em>
            </p>
            <p className="text-xs text-fg-muted">
              SVG · PNG · JPG · WebP · GIF · PDF · PPTX · .desyn · JSON
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={!canEdit}
              onClick={() => input.current?.click()}
            >
              Choose files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept={IMPORT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                add([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </div>
          {items.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="Imports">
              {items.map((item) => {
                const Icon = item.kind ? KIND_ICON[item.kind] : FileText;
                return (
                  <li
                    key={item.id}
                    className="flex items-start gap-3 rounded-card bg-surface-2/40 p-3"
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-fg-secondary" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                          {item.name}
                        </span>
                        <span className="text-[11px] text-fg-muted">
                          {item.kind ? KIND_LABEL[item.kind] : "Unknown"}
                        </span>
                        {item.status === "done" ? (
                          <CheckCircle2 className="size-4 text-success" aria-label="Imported" />
                        ) : item.status === "error" ? (
                          <XCircle className="size-4 text-danger" aria-label="Failed" />
                        ) : null}
                      </div>
                      {item.status === "working" ? (
                        <div className="mt-2 flex flex-col gap-1">
                          <Progress
                            size="sm"
                            value={item.total > 0 ? (item.done / item.total) * 100 : null}
                            label={`Importing ${item.name}`}
                          />
                          {item.message ? (
                            <span className="text-[11px] text-fg-muted">{item.message}</span>
                          ) : null}
                        </div>
                      ) : item.status === "error" && item.message ? (
                        <p className="mt-1 text-xs text-danger">{item.message}</p>
                      ) : item.status === "waiting" ? (
                        <p className="mt-1 text-[11px] text-fg-muted">Waiting…</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-xs text-fg-secondary">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
              {w}
            </p>
          ))}
        </DialogBody>
        <DialogFooter>
          {running ? (
            <Button
              variant="ghost"
              onClick={() => {
                abort.current.abort();
                abort.current = new AbortController();
                setItems((list) =>
                  list.map((i) =>
                    i.status === "working" || i.status === "waiting"
                      ? { ...i, status: "error", message: "Canceled." }
                      : i,
                  ),
                );
              }}
            >
              Cancel imports
            </Button>
          ) : null}
          <Button variant={running ? "secondary" : "primary"} onClick={close}>
            {running ? "Continue in background" : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
