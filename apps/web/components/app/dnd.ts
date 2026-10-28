"use client";

import { toast } from "@desyn/ui";
import { useMutation } from "convex/react";
import { type DragEvent, useCallback, useRef, useState } from "react";
import { api, type Id } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { DND_DESIGN, DND_FOLDER } from "@/lib/folders";

export interface DragPayload {
  id: string;
  name: string;
}

function parse(raw: string): DragPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<DragPayload>;
    return typeof value.id === "string" && typeof value.name === "string"
      ? { id: value.id, name: value.name }
      : null;
  } catch {
    return null;
  }
}

/** Props that make a design card draggable onto folders. */
export function designDragProps(design: DragPayload) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(DND_DESIGN, JSON.stringify(design));
      event.dataTransfer.effectAllowed = "move";
    },
  };
}

export function folderDragProps(folder: DragPayload) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.stopPropagation();
      event.dataTransfer.setData(DND_FOLDER, JSON.stringify(folder));
      event.dataTransfer.effectAllowed = "move";
    },
  };
}

function accepts(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer.types);
  return types.includes(DND_DESIGN) || types.includes(DND_FOLDER);
}

/**
 * A drop target that moves dragged designs into `folderId` (null = workspace root) and dragged
 * folders under it. `canAcceptFolder` guards against dropping a folder into its own subtree.
 */
export function useFolderDrop(
  folderId: Id<"folders"> | null,
  options: {
    folderName: string;
    canAcceptFolder?: (draggedId: string) => boolean;
    messages: { movedDesign: (name: string) => string; movedFolder: (name: string) => string };
  },
) {
  const moveDesign = useMutation(api.designs.designs.moveToFolder);
  const moveFolder = useMutation(api.accounts.folders.move);
  const [isOver, setOver] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((event: DragEvent) => {
    if (!accepts(event)) return;
    depth.current += 1;
    setOver(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDragLeave = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }, []);

  const { canAcceptFolder, messages } = options;
  const onDrop = useCallback(
    async (event: DragEvent) => {
      depth.current = 0;
      setOver(false);
      const design = parse(event.dataTransfer.getData(DND_DESIGN));
      const folder = parse(event.dataTransfer.getData(DND_FOLDER));
      if (!design && !folder) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        if (design) {
          await moveDesign({ designId: design.id as Id<"designs">, folderId });
          toast.success(messages.movedDesign(design.name));
        } else if (folder && folder.id !== folderId) {
          if (canAcceptFolder && !canAcceptFolder(folder.id)) return;
          await moveFolder({ folderId: folder.id as Id<"folders">, parentId: folderId });
          toast.success(messages.movedFolder(folder.name));
        }
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [folderId, moveDesign, moveFolder, canAcceptFolder, messages],
  );

  return { isOver, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
