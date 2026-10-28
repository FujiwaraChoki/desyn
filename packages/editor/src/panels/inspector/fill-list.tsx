"use client";

import type { AssetRef, Fill } from "@desyn/schema";
import { IconButton, PaintSwatchButton, Select } from "@desyn/ui";
import { Eye, EyeOff, ImagePlus, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import { fillToPaint, paintToFill } from "../lib/paint.ts";
import { MiniButton } from "../ui/primitives.tsx";
import { useBrandColors } from "./brand-colors.ts";
import { useDocumentColors } from "./hooks.ts";

/**
 * A list of fills (bottom-to-top in the document, shown top-first): solid / gradient paints with the
 * @desyn/ui paint picker, image fills (replace, fit mode), per-fill opacity and visibility, add / remove.
 * `onPreview` runs while dragging in a picker, `onCommit` once per change; image uploads pass the new asset.
 */
export interface FillListProps {
  fills: Fill[];
  /** `null` = the selection has different fills (shows "Mixed" with a reset button). */
  mixed?: boolean;
  label: string;
  onPreview: (fills: Fill[]) => void;
  onCommit: (fills: Fill[], assets?: AssetRef[]) => void;
  allowImage?: boolean;
  /** Color for a newly added fill. */
  defaultColor?: string;
  max?: number;
}

export function FillList({
  fills,
  mixed = false,
  label,
  onPreview,
  onCommit,
  allowImage = true,
  defaultColor = "#d9d9d9",
  max = 8,
}: FillListProps) {
  const editor = useEditor();
  const design = useEditorStore((s) => s.doc.design);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const documentColors = useDocumentColors();
  const brandColors = useBrandColors();
  const file = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);

  const replaceAt = (i: number, fill: Fill) => fills.map((f, k) => (k === i ? fill : f));

  const pickImage = async (files: FileList | null, index: number | null) => {
    const f = files?.[0];
    if (!f) return;
    setUploading(true);
    try {
      const { ref } = await editor.assets.upload(f, f.name);
      const image: Fill = { type: "image", assetId: ref.id, mode: "fill" };
      onCommit(
        index === null
          ? [...fills, image]
          : replaceAt(index, { ...(fills[index] as Fill), ...image } as Fill),
        [ref],
      );
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't upload the image",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUploading(false);
    }
  };

  if (mixed) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span>Mixed {label.toLowerCase()}</span>
        <button
          type="button"
          disabled={!canEdit}
          // Every layer takes the first layer's paint (or a plain color when it has none).
          onClick={() =>
            onCommit(fills.length > 0 ? fills : [{ type: "solid", color: defaultColor }])
          }
          className="cursor-pointer rounded-[6px] px-2 py-1 text-fg-secondary hover:bg-fg/6 hover:text-fg disabled:opacity-50"
        >
          Use one {label.toLowerCase()}
        </button>
      </div>
    );
  }

  // Shown top-most first, like layers.
  const rows = fills.map((f, i) => ({ f, i })).reverse();
  return (
    <div className="flex flex-col gap-1">
      {rows.map(({ f, i }) => {
        const paint = fillToPaint(design, f);
        const hidden = f.visible === false;
        return (
          <div key={i} className="group flex items-center gap-1">
            {paint ? (
              <PaintSwatchButton
                label={`${label} ${fills.length - i}`}
                value={paint}
                documentColors={documentColors}
                brandColors={brandColors}
                onChange={(p) => onPreview(replaceAt(i, paintToFill(p, f)))}
                onChangeEnd={(p) => onCommit(replaceAt(i, paintToFill(p, f)))}
                className="min-w-0 flex-1"
              />
            ) : f.type === "image" ? (
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <button
                  type="button"
                  disabled={!canEdit || uploading}
                  onClick={() => {
                    setReplacing(i);
                    file.current?.click();
                  }}
                  className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control border border-line-subtle bg-surface-2 pr-2 pl-1 text-xs text-fg hover:border-line"
                >
                  <ImageFillThumb assetId={f.assetId} />
                  <span className="truncate">
                    {uploading && replacing === i ? "Uploading…" : "Image"}
                  </span>
                </button>
                <Select<"fill" | "fit" | "tile" | "stretch">
                  aria-label="Image fill mode"
                  size="sm"
                  value={f.mode}
                  onValueChange={(mode) => onCommit(replaceAt(i, { ...f, mode }))}
                  options={[
                    { value: "fill", label: "Fill" },
                    { value: "fit", label: "Fit" },
                    { value: "tile", label: "Tile" },
                    { value: "stretch", label: "Stretch" },
                  ]}
                  className="w-[78px]"
                  disabled={!canEdit}
                />
              </div>
            ) : null}
            <OpacityChip
              value={f.opacity ?? 1}
              disabled={!canEdit}
              onCommit={(o) => onCommit(replaceAt(i, { ...f, opacity: o } as Fill))}
            />
            <MiniButton
              label={hidden ? "Show fill" : "Hide fill"}
              disabled={!canEdit}
              onClick={() => onCommit(replaceAt(i, { ...f, visible: hidden } as Fill))}
            >
              {hidden ? <EyeOff /> : <Eye />}
            </MiniButton>
            <MiniButton
              label="Remove fill"
              disabled={!canEdit}
              onClick={() => onCommit(fills.filter((_, k) => k !== i))}
            >
              <Minus />
            </MiniButton>
          </div>
        );
      })}
      <div className="flex gap-1">
        {fills.length < max ? (
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => onCommit([...fills, { type: "solid", color: defaultColor }])}
            className="flex h-7 flex-1 cursor-pointer items-center gap-1.5 rounded-control px-2 text-xs text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            Add {label.toLowerCase()}
          </button>
        ) : null}
        {allowImage ? (
          <IconButton
            label="Add image fill"
            size="sm"
            variant="ghost"
            disabled={!canEdit || uploading}
            loading={uploading && replacing === null}
            onClick={() => {
              setReplacing(null);
              file.current?.click();
            }}
          >
            <ImagePlus />
          </IconButton>
        ) : null}
      </div>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          void pickImage(files, replacing).finally(() => {
            e.target.value = "";
          });
        }}
      />
    </div>
  );
}

/** Thumbnail of an image fill through the asset service (signed URL). */
function ImageFillThumb({ assetId }: { assetId: string }) {
  const editor = useEditor();
  const asset = useEditorStore((s) => s.doc.design?.assets[assetId]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset) return;
    let live = true;
    void editor.assets.urlFor(asset).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [editor, asset]);
  return (
    <span className="dsn-checker size-5 shrink-0 overflow-hidden rounded-[4px] shadow-[inset_0_0_0_1px_var(--line-subtle)]">
      {url ? <img src={url} alt="" className="size-full object-cover" /> : null}
    </span>
  );
}

/** Compact opacity percentage next to a fill. */
function OpacityChip({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? `${Math.round(value * 100)}`;
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.replace("%", ""));
    setDraft(null);
    if (Number.isFinite(n)) onCommit(Math.min(1, Math.max(0, n / 100)));
  };
  return (
    <label className="flex h-7 w-[52px] shrink-0 items-center rounded-control border border-line-subtle bg-surface-2 pr-1.5 text-xs text-fg focus-within:ring-2 focus-within:ring-ring">
      <input
        aria-label="Fill opacity"
        value={shown}
        disabled={disabled}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        className="w-full min-w-0 bg-transparent px-1.5 text-right tabular-nums outline-none"
      />
      <span className="text-fg-muted">%</span>
    </label>
  );
}
