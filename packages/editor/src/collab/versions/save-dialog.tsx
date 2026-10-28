"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  ProBadge,
} from "@desyn/ui";
import { Save } from "lucide-react";
import { useState } from "react";
import { useEditor } from "../../context.tsx";
import { errorCode, errorMessage } from "../live.ts";
import { useCollab } from "../state.ts";
import type { ModalProps } from "../ui.ts";
import { cleanVersionName, defaultVersionName } from "./model.ts";
import { useVersionFeature } from "./panel.tsx";

/** "Save a named version" (modal `save-version`, mod+alt+s). */
export function SaveVersionDialog({ close }: ModalProps) {
  const editor = useEditor();
  const { backend } = useCollab();
  const feature = useVersionFeature();
  const [name, setName] = useState(() => defaultVersionName());
  const [busy, setBusy] = useState(false);
  const clean = cleanVersionName(name);

  const save = async () => {
    if (!clean) return;
    setBusy(true);
    try {
      await backend.versions.create(clean);
      editor.notify({
        kind: "success",
        title: `Saved “${clean}”`,
        description: "Find it in the version history (⌥⌘H / Ctrl+Alt+H).",
      });
      editor.telemetry("version_saved", { from: "dialog" });
      close();
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
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            save a <em className="text-accent">version</em>
          </DialogTitle>
          <DialogDescription>
            A named snapshot of the design as it is now. Restore it any time.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {feature === false ? (
            <div className="mb-3 flex items-start gap-2.5 rounded-card border border-line-subtle bg-accent-wash p-3 text-[13px] text-fg-secondary">
              <ProBadge />
              <span>Named versions and history are part of Desyn Pro.</span>
            </div>
          ) : null}
          <Field label="Name" {...(clean ? {} : { error: "Use 1 to 100 characters." })}>
            <Input
              value={name}
              maxLength={100}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Save />}
            loading={busy}
            disabled={!clean || feature === false}
            onClick={() => void save()}
          >
            Save version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
