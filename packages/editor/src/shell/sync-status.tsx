"use client";

import { cn, Tooltip } from "@desyn/ui";
import { CloudAlert, CloudCheck, CloudOff, CloudUpload, RefreshCw } from "lucide-react";
import { useEditorStore } from "../context.tsx";

/**
 * Save state next to the title: saved, saving (own changes waiting for the server), offline (queued on this
 * device), retrying, re-syncing after a gap. Hidden while loading.
 */
export function SyncStatus() {
  const status = useEditorStore((s) => s.doc.sync.status);
  const pending = useEditorStore((s) => s.doc.sync.pending);
  const retrying = useEditorStore((s) => s.doc.sync.retrying);
  const readOnly = useEditorStore((s) => s.mode !== "edit");
  if (status === "loading" || status === "error" || status === "stopped") return null;

  let icon = <CloudCheck />;
  let label = "Saved";
  let hint = "All changes are saved.";
  let tone = "text-fg-muted";
  if (status === "offline") {
    icon = <CloudOff />;
    label = "Offline";
    hint =
      pending > 0
        ? `${pending} ${pending === 1 ? "change is" : "changes are"} saved on this device and will sync when you reconnect.`
        : "You're offline. Changes you make are kept on this device and sync when you reconnect.";
    tone = "text-warning";
  } else if (status === "reloading") {
    icon = <RefreshCw className="animate-spin" />;
    label = "Syncing";
    hint = "Catching up with the latest version.";
  } else if (retrying) {
    icon = <CloudAlert />;
    label = "Retrying";
    hint = `Saving is taking longer than usual (${retrying.message}). Your changes are kept and retried.`;
    tone = "text-warning";
  } else if (status === "syncing" || pending > 0) {
    icon = <CloudUpload />;
    label = "Saving";
    hint = "Saving your changes…";
  } else if (readOnly) {
    hint = "You're seeing the latest version.";
    label = "Live";
  }

  return (
    <Tooltip content={hint}>
      <output
        aria-live="polite"
        className={cn(
          "ml-1 flex h-7 items-center gap-1.5 rounded-full px-2 text-2xs [&_svg]:size-3.5",
          tone,
        )}
      >
        {icon}
        <span className="max-md:sr-only">{label}</span>
      </output>
    </Tooltip>
  );
}
