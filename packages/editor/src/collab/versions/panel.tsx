"use client";

import { can, isPlanId } from "@desyn/schema";
import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  ProBadge,
  SegmentedControl,
  Skeleton,
  SunSpinner,
  useConfirm,
} from "@desyn/ui";
import {
  Bookmark,
  Eye,
  History,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { VersionRow } from "../backend.ts";
import { errorCode, errorMessage, useLive } from "../live.ts";
import { useCollab, useCollabStore } from "../state.ts";
import { type ModalProps, useEntered } from "../ui.ts";
import { cleanVersionName, groupVersions, type VersionFilter } from "./model.ts";
import { useVersionPreview } from "./preview-state.ts";

/** Workspace plan includes version history (null while unknown, e.g. share-link sessions). */
export function useVersionFeature(): boolean | null {
  const { backend } = useCollab();
  const workspaceId = useEditorStore((s) => s.doc.sync.header?.workspaceId ?? null);
  const isShare = useEditorStore((s) => s.shareToken !== null);
  const ws = useLive(!isShare && workspaceId ? `ws:${workspaceId}` : null, () =>
    workspaceId ? backend.workspace(workspaceId) : null,
  );
  const plan = ws.data?.plan;
  return plan && isPlanId(plan) ? can(plan, "versionHistory") : null;
}

function NameCurrent({ onDone }: { onDone?: () => void }) {
  const { backend } = useCollab();
  const editor = useEditor();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = cleanVersionName(name);
  const save = async () => {
    if (!clean) return;
    setBusy(true);
    try {
      await backend.versions.create(clean);
      editor.notify({ kind: "success", title: `Saved “${clean}”` });
      editor.telemetry("version_saved", {});
      setName("");
      onDone?.();
    } catch (e) {
      editor.notify({
        kind: errorCode(e) === "FEATURE_UNAVAILABLE" ? "info" : "error",
        title:
          errorCode(e) === "FEATURE_UNAVAILABLE"
            ? "Version history is part of Desyn Pro"
            : "Couldn't save the version",
        description: errorMessage(e),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex gap-2">
      <Input
        size="sm"
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
        placeholder="Name the current version"
        aria-label="Version name"
        className="min-w-0 flex-1"
      />
      <Button
        size="sm"
        variant="primary"
        leadingIcon={<Save />}
        disabled={!clean}
        loading={busy}
        onClick={() => void save()}
      >
        Save
      </Button>
    </div>
  );
}

function VersionItem({
  version,
  selected,
  canEdit,
  canManage,
}: {
  version: VersionRow;
  selected: boolean;
  canEdit: boolean;
  canManage: boolean;
}) {
  const { backend } = useCollab();
  const editor = useEditor();
  const confirm = useConfirm();
  const { open, restore } = useVersionPreview();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(version.name);
  const time = new Date(version.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const ready = version.status === "ready";

  const rename = async () => {
    setRenaming(false);
    const clean = cleanVersionName(draft);
    if (!clean || clean === version.name) return;
    try {
      await backend.versions.rename(version.id, clean);
    } catch (e) {
      editor.notify({ kind: "error", title: "Couldn't rename", description: errorMessage(e) });
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${version.name}”?`,
      description:
        "The version disappears from the history for everyone. The design is not changed.",
      confirmLabel: "Delete version",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await backend.versions.remove(version.id);
    } catch (e) {
      editor.notify({ kind: "error", title: "Couldn't delete", description: errorMessage(e) });
    }
  };

  return (
    <li
      className={cn(
        "group/version relative flex items-start gap-2.5 rounded-[10px] px-2 py-2 transition-colors",
        selected ? "bg-fg/8" : "hover:bg-fg/[0.04]",
      )}
    >
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          version.auto ? "bg-fg/25" : "bg-accent",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            size="sm"
            value={draft}
            maxLength={100}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
            aria-label="Version name"
          />
        ) : (
          <button
            type="button"
            disabled={!ready}
            onClick={() => void open(version)}
            className="block w-full text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <span
              className={cn(
                "block truncate text-[13px]",
                version.auto ? "text-fg-secondary" : "font-medium text-fg",
              )}
            >
              {version.name}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              {time}
              {version.createdByName ? ` · ${version.createdByName}` : ""}
              {version.status === "pending" ? (
                <span className="inline-flex items-center gap-1">
                  · <SunSpinner size={10} label="Saving" /> saving
                </span>
              ) : null}
              {version.status === "failed" ? (
                <span className="inline-flex items-center gap-1 text-danger">
                  · <TriangleAlert className="size-3" /> failed
                </span>
              ) : null}
            </span>
          </button>
        )}
      </div>
      {!renaming && ready ? (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/version:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
          <IconButton label="Preview" size="xs" variant="ghost" onClick={() => void open(version)}>
            <Eye />
          </IconButton>
          {canEdit ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Version actions" tooltip={false} size="xs" variant="ghost">
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem icon={<RotateCcw />} onSelect={() => void restore(version)}>
                  Restore this version
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={version.auto ? <Bookmark /> : <Pencil />}
                  onSelect={() => {
                    setDraft(version.name);
                    setRenaming(true);
                  }}
                >
                  {version.auto ? "Name this version" : "Rename"}
                </DropdownMenuItem>
                {canManage ? (
                  <DropdownMenuItem icon={<Trash2 />} destructive onSelect={() => void remove()}>
                    Delete
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Version history (modal `versions`, mod+alt+h): a side panel over the inspector so the canvas stays visible
 * for previews. Named and autosaved versions by day, preview read-only on the canvas, restore, rename,
 * delete, and naming the current state.
 */
export function VersionsPanel({ close }: ModalProps) {
  const { backend, store } = useCollab();
  const designId = useEditorStore((s) => s.designId);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const canManage = useEditorStore((s) => s.permission === "manage");
  const feature = useVersionFeature();
  const versions = useLive(`versions:${designId}`, () => backend.versions.list());
  const previewId = useCollabStore((s) => s.versionPreview?.versionId ?? null);
  const [filter, setFilter] = useState<VersionFilter>("all");
  const groups = useMemo(
    () => (versions.data ? groupVersions(versions.data, filter) : []),
    [versions.data, filter],
  );
  const entered = useEntered();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (store.getState().versionPreview) store.setState({ versionPreview: null });
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, store]);

  const onClose = () => {
    store.setState({ versionPreview: null });
    close();
  };

  return (
    <aside
      aria-label="Version history"
      className={cn(
        "fixed top-12 right-0 bottom-0 z-30 flex w-[min(340px,100vw)] flex-col border-l border-line-subtle bg-surface-1 shadow-dialog transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none",
        entered ? "translate-x-0 opacity-100" : "translate-x-6 opacity-0",
      )}
    >
      <header className="flex items-center gap-2 px-4 pt-4 pb-3">
        <h2 className="flex-1 font-serif text-[22px] leading-none text-fg">
          version <em className="text-accent">history</em>
        </h2>
        <IconButton label="Close" size="sm" variant="ghost" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="flex flex-col gap-3 border-b border-line-subtle px-4 pb-3">
        {feature === false ? (
          <div className="flex items-start gap-2.5 rounded-card border border-line-subtle bg-accent-wash p-3 text-[13px] text-fg-secondary">
            <ProBadge />
            <span>Upgrade to keep named and autosaved versions and restore any of them.</span>
          </div>
        ) : canEdit ? (
          <NameCurrent />
        ) : null}
        <SegmentedControl
          size="sm"
          fullWidth
          aria-label="Show versions"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "named", label: "Named" },
            { value: "auto", label: "Autosaved" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {versions.error ? (
          <EmptyState
            size="sm"
            icon={<History />}
            title={
              <>
                history is <em className="text-accent">unavailable</em>
              </>
            }
            description={versions.error}
          />
        ) : !versions.data ? (
          <div className="flex flex-col gap-2 p-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<History />}
            title={
              filter === "named" ? (
                <>
                  no named versions <em className="text-accent">yet</em>
                </>
              ) : (
                <>
                  no versions <em className="text-accent">yet</em>
                </>
              )
            }
            description={
              feature === false
                ? "Version history comes with Desyn Pro."
                : "Desyn saves a version every few minutes while you edit. Name one to find it later."
            }
          />
        ) : (
          groups.map((g) => (
            <section key={g.label} className="mb-2">
              <h3 className="px-2 pt-2 pb-1 text-[11px] font-medium text-fg-muted">{g.label}</h3>
              <ul>
                {g.versions.map((v) => (
                  <VersionItem
                    key={v.id}
                    version={v}
                    selected={v.id === previewId}
                    canEdit={canEdit}
                    canManage={canManage}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <footer className="flex items-center gap-2 border-t border-line-subtle px-4 py-2.5 text-[11px] text-fg-muted">
        <span className="size-2 rounded-full bg-accent" aria-hidden /> Named
        <span className="ml-2 size-2 rounded-full bg-fg/25" aria-hidden /> Autosaved
        <div className="flex-1" />
        {versions.data ? (
          <Badge size="sm" tone="neutral">
            {versions.data.length}
          </Badge>
        ) : null}
      </footer>
    </aside>
  );
}
