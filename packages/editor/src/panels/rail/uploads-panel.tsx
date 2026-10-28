"use client";

import { type AssetRef, createAudio, createImage, createSvg, createVideo } from "@desyn/schema";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Progress,
  useConfirm,
} from "@desyn/ui";
import {
  ArrowLeft,
  CloudUpload,
  FileAudio,
  FileVideo,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  PenLine,
  Plus,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";
import { assetRefFromView, mimeOf } from "../../sync/assets.ts";
import type { AssetView } from "../../sync/convex-transport.ts";
import {
  type AssetFolderView,
  errorMessage,
  refs,
  useBackendQuery,
  usePaginatedBackendQuery,
  useWorkspaceId,
} from "../backend.ts";
import { TEXT_PRESETS, textFromPreset } from "../lib/catalog.ts";
import { loadPreviewFont } from "../lib/fonts.ts";
import { fitToPage, insertSubtree } from "../lib/insert.ts";
import { updateEach } from "../lib/ops.ts";
import { pageInk } from "../lib/page-color.ts";
import {
  ChipRow,
  LoadMore,
  PanelBody,
  PanelEmpty,
  SearchField,
  TileGrid,
  TileSkeletons,
  useDebounced,
} from "../ui/primitives.tsx";

/**
 * Uploads: the workspace library. Drop files on the panel (or pick them), watch them upload with progress,
 * organize them in folders, rename or delete them, and click one to place it. Fonts are added to the design
 * and applied to selected text.
 */

type KindFilter = "all" | "image" | "svg" | "video" | "audio" | "font";

const ACCEPT = "image/*,.svg,video/mp4,video/webm,audio/mpeg,audio/wav,.ttf,.otf,.woff,.woff2";

interface UploadJob {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
  ctrl: AbortController;
}

/** Places a library asset on the current page (fonts: applied to selected text, else a text box). */
export async function placeAsset(editor: EditorController, view: AssetView): Promise<void> {
  if (!editor.canEdit) return;
  const ref: AssetRef = assetRefFromView(view);
  if (view.url) editor.assets.prime(ref.id, view.url);
  const page = editor.currentPage();
  const name = view.name.replace(/\.[^.]+$/, "") || "Upload";
  if (ref.kind === "font") {
    const family = ref.family ?? name;
    const textIds = editor
      .selectedNodes()
      .filter((n) => n.type === "text")
      .map((n) => n.id);
    if (textIds.length > 0) {
      await editor.apply(
        (design) => [
          ...(design.assets[ref.id] ? [] : [{ op: "asset" as const, set: { [ref.id]: ref } }]),
          ...updateEach(design, textIds, (n) =>
            n.type === "text"
              ? {
                  style: {
                    ...n.style,
                    fontFamily: family,
                    ...(ref.weight ? { fontWeight: ref.weight } : {}),
                    ...(ref.style ? { fontStyle: ref.style } : {}),
                  },
                  // Per-run families would hide the new font; the whole layer takes it.
                  runs: n.runs.map((r) => {
                    if (!r.style?.fontFamily) return r;
                    const { fontFamily: _f, ...style } = r.style;
                    return Object.keys(style).length > 0 ? { ...r, style } : { text: r.text };
                  }),
                }
              : null,
          ),
        ],
        { label: "Use uploaded font" },
      );
      return;
    }
    const preset = TEXT_PRESETS.find((p) => p.id === "subheading");
    if (!preset) return;
    await insertSubtree(editor, [textFromPreset(preset, family, pageInk(editor))], {
      label: "Add text",
      assets: [ref],
    });
    return;
  }
  if (ref.kind === "audio") {
    await insertSubtree(editor, [createAudio({ assetId: ref.id, name })], {
      label: "Add audio",
      assets: [ref],
      keepPosition: true,
    });
    return;
  }
  const size = fitToPage(view.width ?? 800, view.height ?? 600, page, 0.7);
  const node =
    ref.kind === "svg"
      ? createSvg({ assetId: ref.id, name, ...size })
      : ref.kind === "video"
        ? createVideo({ assetId: ref.id, name, ...size })
        : createImage({ assetId: ref.id, name, ...size });
  await insertSubtree(editor, [node], {
    label: ref.kind === "video" ? "Add video" : "Add image",
    assets: [ref],
  });
}

export function UploadsPanel() {
  const editor = useEditor();
  const workspaceId = useWorkspaceId();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 300);
  const [folder, setFolder] = useState<AssetFolderView | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folders = useBackendQuery(refs.foldersList, workspaceId ? { workspaceId } : "skip");
  const all = usePaginatedBackendQuery(
    refs.assetsList,
    workspaceId && !folder
      ? { workspaceId, ...(kind !== "all" ? { kind } : {}), ...(q ? { search: q } : {}) }
      : "skip",
    30,
  );
  const inFolder = usePaginatedBackendQuery(
    refs.foldersAssets,
    folder ? { folderId: folder.id } : "skip",
    30,
  );
  const source = folder ? inFolder : all;
  const items = (source.items as AssetView[]).filter(
    (a) =>
      !folder ||
      ((kind === "all" || a.kind === kind) &&
        (!q || a.name.toLowerCase().includes(q.toLowerCase()))),
  );

  const upload = useCallback(
    async (files: File[]) => {
      if (!editor.canEdit || files.length === 0) return;
      const created = files.map(
        (f): UploadJob => ({
          id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`,
          name: f.name,
          progress: 0,
          status: "uploading",
          ctrl: new AbortController(),
        }),
      );
      setJobs((j) => [...created, ...j]);
      const update = (id: string, patch: Partial<UploadJob>) =>
        setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));
      const uploaded: string[] = [];
      await Promise.all(
        files.map(async (file, i) => {
          const job = created[i] as UploadJob;
          try {
            const typed = file.type ? file : new File([file], file.name, { type: mimeOf(file) });
            const result = await editor.assets.upload(typed, file.name, {
              onProgress: (r) => update(job.id, { progress: r }),
              signal: job.ctrl.signal,
            });
            uploaded.push(result.assetId);
            update(job.id, { status: "done", progress: 1 });
            editor.telemetry("asset_uploaded", {
              kind: result.ref.kind,
              dedup: result.deduplicated,
            });
          } catch (e) {
            const cancelled = e instanceof DOMException && e.name === "AbortError";
            update(job.id, { status: "error", error: cancelled ? "Cancelled" : errorMessage(e) });
          }
        }),
      );
      // Uploads made inside a folder go into it.
      if (folder && workspaceId && uploaded.length > 0 && editor.convex) {
        await editor.convex
          .mutation(refs.foldersMove, { workspaceId, assetIds: uploaded, folderId: folder.id })
          .catch(() => undefined);
      }
      // Finished rows fade out after a moment; failures stay until dismissed.
      setTimeout(() => setJobs((list) => list.filter((j) => j.status !== "done")), 2400);
    },
    [editor, folder, workspaceId],
  );

  if (all.status === "unavailable") {
    return (
      <PanelBody>
        <PanelEmpty
          icon={<CloudUpload />}
          title={
            <>
              your library, <em className="text-accent">anywhere</em>
            </>
          }
          description="Uploads are stored in your Desyn workspace. Open the design in the app to use them."
        />
      </PanelBody>
    );
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload([...e.dataTransfer.files]);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the panel is a drop target; the button below is the accessible way in
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (!canEdit || ![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.stopPropagation();
        onDrop(e);
      }}
    >
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
        <Button
          variant="primary"
          size="md"
          className="w-full"
          leadingIcon={<Upload />}
          disabled={!canEdit || !workspaceId}
          onClick={() => input.current?.click()}
        >
          Upload files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void upload(files);
          }}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search uploads"
          placeholder="Search your uploads"
        />
        <ChipRow
          label="File type"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "image", label: "Images" },
            { value: "svg", label: "Graphics" },
            { value: "video", label: "Videos" },
            { value: "audio", label: "Audio" },
            { value: "font", label: "Fonts" },
          ]}
        />
      </div>
      {jobs.length > 0 ? (
        <UploadJobs jobs={jobs} onDismiss={(id) => setJobs((j) => j.filter((x) => x.id !== id))} />
      ) : null}
      <PanelBody>
        {folder ? (
          <div className="flex items-center gap-1 pt-1">
            <IconButton
              label="All uploads"
              size="xs"
              variant="ghost"
              onClick={() => setFolder(null)}
            >
              <ArrowLeft />
            </IconButton>
            <Folder className="size-3.5 text-accent" />
            <span className="truncate text-sm text-fg">{folder.name}</span>
          </div>
        ) : (
          <Folders
            folders={folders.data ?? []}
            workspaceId={workspaceId}
            onOpen={(f) => setFolder(f)}
          />
        )}
        <div className="pt-3">
          {source.status === "loading" && items.length === 0 ? (
            <TileGrid min={88}>
              <TileSkeletons count={9} />
            </TileGrid>
          ) : source.status === "error" && items.length === 0 ? (
            <PanelEmpty
              icon={<CloudUpload />}
              title={
                <>
                  uploads are <em className="text-accent">out of reach</em>
                </>
              }
              description={source.error ? errorMessage(source.error) : "Try again in a moment."}
            />
          ) : items.length === 0 ? (
            <PanelEmpty
              icon={<CloudUpload />}
              title={
                q ? (
                  <>
                    nothing <em className="text-accent">found</em>
                  </>
                ) : (
                  <>
                    drop files <em className="text-accent">here</em>
                  </>
                )
              }
              description={
                q
                  ? `No uploads match “${q}”.`
                  : "Images, SVG, video, audio and fonts. They stay in your workspace library."
              }
            />
          ) : (
            <TileGrid min={88}>
              {items.map((a) => (
                <AssetTile
                  key={a.id}
                  asset={a}
                  folders={folders.data ?? []}
                  workspaceId={workspaceId}
                  inFolder={folder}
                />
              ))}
            </TileGrid>
          )}
          <LoadMore
            onLoad={source.loadMore}
            loading={source.loadingMore}
            visible={source.canLoadMore}
          />
        </div>
      </PanelBody>
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-[14px] border-2 border-dashed border-accent/70 bg-accent/10 backdrop-blur-[1px]">
          <span className="flex items-center gap-2 rounded-full bg-surface-1/90 px-4 py-2 text-sm text-fg shadow-popover">
            <CloudUpload className="size-4 text-accent" />
            Drop to upload{folder ? ` to ${folder.name}` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function UploadJobs({ jobs, onDismiss }: { jobs: UploadJob[]; onDismiss: (id: string) => void }) {
  return (
    <ul aria-label="Uploads in progress" className="flex shrink-0 flex-col gap-1.5 px-3 pb-2">
      {jobs.map((j) => (
        <li key={j.id} className="flex flex-col gap-1 rounded-[10px] bg-surface-2 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-fg">{j.name}</span>
            <span
              className={cn(
                "text-2xs tabular-nums",
                j.status === "error"
                  ? "text-danger"
                  : j.status === "done"
                    ? "text-success"
                    : "text-fg-muted",
              )}
            >
              {j.status === "error"
                ? "Failed"
                : j.status === "done"
                  ? "Done"
                  : `${Math.round(j.progress * 100)}%`}
            </span>
            <IconButton
              label={j.status === "uploading" ? `Cancel ${j.name}` : `Dismiss ${j.name}`}
              size="xs"
              variant="ghost"
              onClick={() => (j.status === "uploading" ? j.ctrl.abort() : onDismiss(j.id))}
            >
              <X />
            </IconButton>
          </div>
          {j.status === "error" ? (
            <p className="text-2xs text-fg-muted">{j.error}</p>
          ) : (
            <Progress value={j.progress * 100} label={`Uploading ${j.name}`} size="sm" />
          )}
        </li>
      ))}
    </ul>
  );
}

function Folders({
  folders,
  workspaceId,
  onOpen,
}: {
  folders: AssetFolderView[];
  workspaceId: string | null;
  onOpen: (f: AssetFolderView) => void;
}) {
  const editor = useEditor();
  const confirm = useConfirm();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const convex = editor.convex;

  const create = async () => {
    const n = name.trim();
    setCreating(false);
    setName("");
    if (!n || !convex || !workspaceId) return;
    await convex.mutation(refs.foldersCreate, { workspaceId, name: n }).catch((e: unknown) =>
      editor.notify({
        kind: "error",
        title: "Couldn't create the folder",
        description: errorMessage(e),
      }),
    );
  };
  const rename = async (folderId: string) => {
    const n = name.trim();
    setRenaming(null);
    setName("");
    if (!n || !convex) return;
    await convex.mutation(refs.foldersRename, { folderId, name: n }).catch((e: unknown) =>
      editor.notify({
        kind: "error",
        title: "Couldn't rename the folder",
        description: errorMessage(e),
      }),
    );
  };
  const remove = async (f: AssetFolderView) => {
    if (!convex) return;
    const ok = await confirm({
      title: `Delete “${f.name}”?`,
      description: "The folder goes away; its files stay in your uploads.",
      confirmLabel: "Delete folder",
      tone: "danger",
    });
    if (!ok) return;
    await convex.mutation(refs.foldersRemove, { folderId: f.id }).catch((e: unknown) =>
      editor.notify({
        kind: "error",
        title: "Couldn't delete the folder",
        description: errorMessage(e),
      }),
    );
  };

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="flex h-6 items-center justify-between">
        <span className="text-xs font-medium text-fg-secondary">Folders</span>
        <IconButton
          label="New folder"
          size="xs"
          variant="ghost"
          disabled={!canEdit || !workspaceId}
          onClick={() => {
            setName("");
            setCreating(true);
          }}
        >
          <FolderPlus />
        </IconButton>
      </div>
      {creating ? (
        <FolderNameInput
          value={name}
          onChange={setName}
          onCommit={create}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {folders.length === 0 && !creating ? (
        <p className="text-2xs text-fg-muted">Group uploads by project or campaign.</p>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        {folders.map((f) =>
          renaming === f.id ? (
            <FolderNameInput
              key={f.id}
              value={name}
              onChange={setName}
              onCommit={() => void rename(f.id)}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <div key={f.id} className="group relative">
              <button
                type="button"
                onClick={() => onOpen(f)}
                className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-[10px] bg-surface-2 pr-7 pl-2.5 text-left transition-colors hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Folder className="size-4 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-xs text-fg">{f.name}</span>
                <span className="text-2xs text-fg-muted tabular-nums">
                  {f.count >= 100 ? "99+" : f.count}
                </span>
              </button>
              {canEdit ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${f.name} options`}
                      className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[6px] text-fg-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-fg/8 hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      icon={<PenLine />}
                      onSelect={() => {
                        setName(f.name);
                        setRenaming(f.id);
                      }}
                    >
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<Trash2 />} destructive onSelect={() => void remove(f)}>
                      Delete folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function FolderNameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Input
      ref={ref}
      size="sm"
      value={value}
      maxLength={60}
      aria-label="Folder name"
      placeholder="Folder name"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}

function AssetTile({
  asset,
  folders,
  workspaceId,
  inFolder,
}: {
  asset: AssetView;
  folders: AssetFolderView[];
  workspaceId: string | null;
  inFolder: AssetFolderView | null;
}) {
  const editor = useEditor();
  const confirm = useConfirm();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(asset.name);
  const convex = editor.convex;

  useEffect(() => {
    if (asset.kind === "font" && asset.family) void loadPreviewFont(asset.family);
  }, [asset.kind, asset.family]);

  const place = async () => {
    setBusy(true);
    await placeAsset(editor, asset).catch((e: unknown) =>
      editor.notify({
        kind: "error",
        title: "Couldn't place the file",
        description: errorMessage(e),
      }),
    );
    setBusy(false);
  };
  const remove = async () => {
    if (!convex) return;
    const ok = await confirm({
      title: `Delete “${asset.name}”?`,
      description: "It leaves your library. Designs that already use it keep working.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    await convex.mutation(refs.assetsDelete, { assetId: asset.id }).catch((e: unknown) =>
      editor.notify({
        kind: "error",
        title: "Couldn't delete the file",
        description: errorMessage(e),
      }),
    );
  };
  const rename = async () => {
    setRenaming(false);
    const n = name.trim();
    if (!n || n === asset.name || !convex) return;
    await convex.mutation(refs.assetsRename, { assetId: asset.id, name: n }).catch((e: unknown) =>
      editor.notify({
        kind: "error",
        title: "Couldn't rename the file",
        description: errorMessage(e),
      }),
    );
  };
  const move = async (folderId: string | null) => {
    if (!convex || !workspaceId) return;
    await convex
      .mutation(refs.foldersMove, { workspaceId, assetIds: [asset.id], folderId })
      .catch((e: unknown) =>
        editor.notify({
          kind: "error",
          title: "Couldn't move the file",
          description: errorMessage(e),
        }),
      );
  };

  const ratio = asset.width && asset.height ? asset.width / asset.height : 1;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex min-w-0 flex-col gap-1">
          <button
            type="button"
            aria-label={`Place ${asset.name}`}
            aria-busy={busy || undefined}
            disabled={!canEdit}
            onClick={() => void place()}
            className="group/tile relative grid aspect-square w-full cursor-pointer place-items-center overflow-hidden rounded-[10px] bg-surface-2 outline-none transition-colors duration-200 hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          >
            <AssetPreview asset={asset} ratio={ratio} />
            {busy ? (
              <span className="absolute inset-0 grid place-items-center bg-surface-1/60">
                <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
              </span>
            ) : null}
          </button>
          {renaming ? (
            <Input
              size="sm"
              value={name}
              autoFocus
              aria-label="File name"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <span className="truncate px-0.5 text-2xs text-fg-muted" title={asset.name}>
              {asset.name}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem icon={<Plus />} disabled={!canEdit} onSelect={() => void place()}>
          Add to page
        </ContextMenuItem>
        <ContextMenuItem
          icon={<PenLine />}
          disabled={!canEdit}
          onSelect={() => {
            setName(asset.name);
            setRenaming(true);
          }}
        >
          Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={<FolderInput />} disabled={!canEdit}>
            Move to folder
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            {inFolder ? (
              <ContextMenuItem onSelect={() => void move(null)}>
                Remove from “{inFolder.name}”
              </ContextMenuItem>
            ) : null}
            {folders
              .filter((f) => f.id !== inFolder?.id)
              .map((f) => (
                <ContextMenuItem key={f.id} icon={<Folder />} onSelect={() => void move(f.id)}>
                  {f.name}
                </ContextMenuItem>
              ))}
            {folders.length === 0 ? (
              <p className="px-2 py-1.5 text-2xs text-fg-muted">Create a folder first.</p>
            ) : null}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={<Trash2 />}
          destructive
          disabled={!canEdit}
          onSelect={() => void remove()}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function AssetPreview({ asset, ratio }: { asset: AssetView; ratio: number }) {
  if ((asset.kind === "image" || asset.kind === "svg") && asset.url) {
    return (
      <>
        {asset.kind === "svg" || asset.mime === "image/png" ? (
          <span aria-hidden className="dsn-checker absolute inset-0 opacity-30" />
        ) : null}
        <img
          src={asset.url}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(
            "relative size-full transition-transform duration-500 ease-out group-hover/tile:scale-[1.04]",
            asset.kind === "svg" || ratio > 2.5 || ratio < 0.4
              ? "object-contain p-2"
              : "object-cover",
          )}
        />
      </>
    );
  }
  if (asset.kind === "font") {
    return (
      <span className="flex flex-col items-center gap-0.5">
        <span
          className="text-[28px] leading-none text-fg"
          style={{ fontFamily: `"${asset.family ?? asset.name}", ui-sans-serif` }}
        >
          Aa
        </span>
        <Type className="size-3 text-fg-muted" />
      </span>
    );
  }
  if (asset.kind === "video") return <FileVideo className="size-6 text-fg-secondary" />;
  if (asset.kind === "audio") return <FileAudio className="size-6 text-fg-secondary" />;
  return <CloudUpload className="size-6 text-fg-muted" />;
}
