"use client";

import { replaceImage } from "@desyn/doc-ops";
import {
  type Design,
  defaultImageAdjust,
  type Id,
  type ImageAdjust,
  type ImageNode,
  type Node,
} from "@desyn/schema";
import { Button, cn, SegmentedControl, Slider, Textarea } from "@desyn/ui";
import { Crop, ImageUp, RotateCcw, ZoomIn } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useCommand, useEditor, useRegistryVersion } from "../../context.tsx";
import {
  cropFocus,
  cropZoom,
  focusCropPatch,
  sourceSize,
  visibleRegion,
  zoomCropPatch,
} from "../lib/image-crop.ts";
import { useLiveEdit } from "../lib/live.ts";
import { common, updateEach } from "../lib/ops.ts";
import { CenteredSlider, InspectorSection, Row } from "../ui/primitives.tsx";
import type { InspectorTarget } from "./hooks.ts";

/**
 * Images: replace, fit / crop (zoom + focus), shape, filter presets (ids the raster engine knows), fine
 * adjustments, alt text, and AI actions handed to the AI dock (remove background, upscale, expand, erase).
 */

/** Filter presets rendered by crates/desyn-raster (`ImageAdjust.filter`), with CSS approximations for the tiles. */
const FILTERS: { id: string; label: string; css: string }[] = [
  { id: "vivid", label: "Vivid", css: "saturate(1.45) contrast(1.08)" },
  { id: "warm", label: "Warm", css: "sepia(0.25) saturate(1.2) hue-rotate(-8deg)" },
  { id: "cool", label: "Cool", css: "saturate(1.05) hue-rotate(12deg) brightness(1.03)" },
  { id: "mono", label: "Mono", css: "grayscale(1)" },
  { id: "noir", label: "Noir", css: "grayscale(1) contrast(1.45) brightness(0.9)" },
  { id: "vintage", label: "Vintage", css: "sepia(0.45) contrast(0.92) saturate(0.85)" },
  { id: "fade", label: "Fade", css: "contrast(0.82) brightness(1.08) saturate(0.85)" },
  { id: "dramatic", label: "Dramatic", css: "contrast(1.35) saturate(1.1) brightness(0.92)" },
  { id: "film", label: "Film", css: "sepia(0.18) contrast(1.1) saturate(0.9)" },
  { id: "sunset", label: "Sunset", css: "sepia(0.3) saturate(1.35) hue-rotate(-18deg)" },
  { id: "matte", label: "Matte", css: "contrast(0.88) brightness(1.05) saturate(0.95)" },
  { id: "chrome", label: "Chrome", css: "contrast(1.2) saturate(1.25) brightness(1.04)" },
  { id: "lush", label: "Lush", css: "saturate(1.5) hue-rotate(-4deg)" },
  {
    id: "dusk",
    label: "Dusk",
    css: "saturate(0.9) hue-rotate(18deg) brightness(0.92) contrast(1.05)",
  },
];

type AdjustKey = keyof ImageAdjust | "highlights" | "shadows";

const ADJUSTMENTS: {
  key: AdjustKey;
  label: string;
  min: number;
  max: number;
  scale: number;
  unit?: string;
}[] = [
  { key: "exposure", label: "Exposure", min: -100, max: 100, scale: 100 },
  { key: "brightness", label: "Brightness", min: -100, max: 100, scale: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100, scale: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100, scale: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100, scale: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100, scale: 100 },
  { key: "temperature", label: "Warmth", min: -100, max: 100, scale: 100 },
  { key: "tint", label: "Tint", min: -100, max: 100, scale: 100 },
  { key: "hue", label: "Hue", min: -180, max: 180, scale: 1, unit: "°" },
  { key: "vignette", label: "Vignette", min: 0, max: 100, scale: 100 },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100, scale: 100 },
  { key: "grain", label: "Grain", min: 0, max: 100, scale: 100 },
  { key: "blur", label: "Blur", min: 0, max: 50, scale: 1, unit: "px" },
];

function adjustOf(n: ImageNode): ImageAdjust & Record<string, unknown> {
  return { ...defaultImageAdjust(), ...(n.adjust ?? {}) } as ImageAdjust & Record<string, unknown>;
}

function isNeutral(a: ImageAdjust & Record<string, unknown>): boolean {
  return ADJUSTMENTS.every((x) => !a[x.key]) && !a.filter && !a.grayscale && !a.sepia && !a.duotone;
}

export function ImageSection({ target }: { target: InspectorTarget }) {
  const editor = useEditor();
  const { nodes, editable, design } = target;
  const images = nodes.filter((n): n is ImageNode => n.type === "image");
  const ids: Id[] = images.map((n) => n.id);
  const adjustEdit = useLiveEdit("Adjust image");
  const cropEdit = useLiveEdit("Crop image");
  const misc = useLiveEdit("Image");
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const first = images[0];
  const url = useAssetUrl(first?.assetId ?? null);
  if (images.length === 0 || !first) return null;

  const fit = common(images as Node[], (n) => (n as ImageNode).fit);
  const shape = common(images as Node[], (n) =>
    (n as ImageNode).shape === "ellipse" ? "ellipse" : "rect",
  );
  const filter = common(images as Node[], (n) => (n as ImageNode).adjust?.filter ?? "");
  const adjust = adjustOf(first);
  const disabled = !editable;
  const single = images.length === 1;

  const setAdjust = (patch: Record<string, unknown>) => (d: Design) =>
    updateEach(d, ids, (n) => {
      if (n.type !== "image") return null;
      const next = { ...adjustOf(n), ...patch } as ImageAdjust & Record<string, unknown>;
      for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
      return { adjust: isNeutral(next) ? undefined : next };
    });
  const setZoom = (zoom: number) => (d: Design) =>
    updateEach(d, ids, (n) => {
      if (n.type !== "image") return null;
      const { sw, sh } = sourceSize(d, n);
      return zoomCropPatch(n, sw, sh, zoom);
    });
  const setFocus = (axis: "x" | "y", t: number) => (d: Design) =>
    updateEach(d, ids, (n) => {
      if (n.type !== "image") return null;
      const { sw, sh } = sourceSize(d, n);
      return focusCropPatch(n, sw, sh, axis, t);
    });

  const replace = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !single) return;
    setUploading(true);
    try {
      const { ref } = await editor.assets.upload(f, f.name);
      const { url: _u, ...asset } = ref;
      await editor.apply((d) => replaceImage(d, first.id, ref.id, { asset }), {
        label: "Replace image",
      });
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't replace the image",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUploading(false);
    }
  };

  const source = design ? sourceSize(design, first) : { sw: first.width, sh: first.height };
  const zoom = cropZoom(first, source.sw, source.sh);
  const focus = cropFocus(first, source.sw, source.sh);
  const focusX = focus.x;
  const focusY = focus.y;
  // An axis can move only when the image shows part of it.
  const shown = visibleRegion(first, source.sw, source.sh);
  const canPanX = shown.w < 0.9999;
  const canPanY = shown.h < 0.9999;
  const visibleAdjust = showAll ? ADJUSTMENTS : ADJUSTMENTS.slice(0, 6);

  return (
    <>
      <InspectorSection title="Image">
        {single ? (
          <div className="flex gap-2">
            <div className="dsn-checker relative h-16 w-20 shrink-0 overflow-hidden rounded-[8px] border border-line-subtle">
              {url ? (
                <img
                  src={url}
                  alt=""
                  className="size-full object-cover"
                  style={{ filter: FILTERS.find((f) => f.id === filter)?.css }}
                />
              ) : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
              <Button
                size="xs"
                variant="secondary"
                leadingIcon={<ImageUp />}
                loading={uploading}
                disabled={disabled}
                onClick={() => file.current?.click()}
              >
                Replace
              </Button>
              <Button
                size="xs"
                variant="ghost"
                leadingIcon={<RotateCcw />}
                disabled={disabled || isNeutral(adjust)}
                onClick={() =>
                  adjustEdit.apply((d) => updateEach(d, ids, () => ({ adjust: undefined })))
                }
              >
                Reset edits
              </Button>
            </div>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={(e) =>
                void replace(e.target.files).finally(() => {
                  e.target.value = "";
                })
              }
            />
          </div>
        ) : null}
        <SegmentedControl<ImageNode["fit"]>
          size="sm"
          fullWidth
          aria-label="Image fit"
          value={fit ?? undefined}
          onValueChange={(v) => misc.apply((d) => updateEach(d, ids, () => ({ fit: v })))}
          options={[
            { value: "fill", label: "Fill", disabled },
            { value: "fit", label: "Fit", disabled },
            {
              value: "crop",
              label: (
                <>
                  <Crop className="size-3.5" />
                  Crop
                </>
              ),
              "aria-label": "Crop",
              disabled,
            },
            { value: "tile", label: "Tile", disabled },
          ]}
        />
        {fit === "crop" && single ? (
          <div className="flex flex-col gap-1">
            <Row
              label={
                <span className="flex items-center gap-1">
                  <ZoomIn className="size-3" />
                  Zoom
                </span>
              }
            >
              <Slider
                aria-label="Crop zoom"
                size="sm"
                min={100}
                max={500}
                step={5}
                value={[Math.round(zoom * 100)]}
                disabled={disabled}
                showValue
                formatValue={(v) => `${v}%`}
                onValueChange={([v]) => cropEdit.preview(setZoom((v ?? 100) / 100))}
                onValueCommit={([v]) => cropEdit.commit(setZoom((v ?? 100) / 100))}
              />
            </Row>
            <Row label="Focus X">
              <Slider
                aria-label="Crop horizontal focus"
                size="sm"
                min={0}
                max={100}
                value={[Math.round(focusX * 100)]}
                disabled={disabled || !canPanX}
                onValueChange={([v]) => cropEdit.preview(setFocus("x", (v ?? 50) / 100))}
                onValueCommit={([v]) => cropEdit.commit(setFocus("x", (v ?? 50) / 100))}
              />
            </Row>
            <Row label="Focus Y">
              <Slider
                aria-label="Crop vertical focus"
                size="sm"
                min={0}
                max={100}
                value={[Math.round(focusY * 100)]}
                disabled={disabled || !canPanY}
                onValueChange={([v]) => cropEdit.preview(setFocus("y", (v ?? 50) / 100))}
                onValueCommit={([v]) => cropEdit.commit(setFocus("y", (v ?? 50) / 100))}
              />
            </Row>
          </div>
        ) : null}
        <Row label="Shape">
          <SegmentedControl<"rect" | "ellipse">
            size="sm"
            fullWidth
            aria-label="Image shape"
            value={shape ?? undefined}
            onValueChange={(v) =>
              misc.apply((d) => updateEach(d, ids, () => ({ shape: v === "rect" ? undefined : v })))
            }
            options={[
              { value: "rect", label: "Rectangle", disabled },
              { value: "ellipse", label: "Ellipse", disabled },
            ]}
          />
        </Row>
        {single ? (
          <Textarea
            aria-label="Alt text"
            placeholder="Describe the image for screen readers"
            defaultValue={first.alt ?? ""}
            key={first.id}
            disabled={disabled}
            maxLength={500}
            minRows={2}
            className="text-xs"
            onBlur={(e) => {
              const alt = e.target.value.trim();
              misc.apply((d) => updateEach(d, ids, () => ({ alt: alt || undefined })));
            }}
          />
        ) : null}
      </InspectorSection>
      <InspectorSection title="Filters">
        <div className="grid grid-cols-4 gap-1.5">
          <FilterTile
            label="None"
            active={!filter}
            url={url}
            css="none"
            disabled={disabled}
            onClick={() => adjustEdit.apply(setAdjust({ filter: undefined }))}
          />
          {FILTERS.map((f) => (
            <FilterTile
              key={f.id}
              label={f.label}
              active={filter === f.id}
              url={url}
              css={f.css}
              disabled={disabled}
              onClick={() => adjustEdit.apply(setAdjust({ filter: f.id }))}
            />
          ))}
        </div>
      </InspectorSection>
      <InspectorSection
        title="Adjust"
        actions={
          <button
            type="button"
            onClick={() => setShowAll((s) => !s)}
            className="cursor-pointer rounded-[6px] px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-fg/6 hover:text-fg"
          >
            {showAll ? "Fewer" : "All adjustments"}
          </button>
        }
      >
        {visibleAdjust.map((a) => {
          const raw = Number(adjust[a.key] ?? 0);
          const value = Math.round(raw * a.scale);
          const AdjustSlider = a.min < 0 ? CenteredSlider : Slider;
          return (
            <Row key={a.key} label={a.label}>
              <AdjustSlider
                aria-label={a.label}
                size="sm"
                min={a.min}
                max={a.max}
                step={1}
                value={[value]}
                disabled={disabled}
                showValue
                formatValue={(v) => `${v > 0 && a.min < 0 ? "+" : ""}${v}${a.unit ?? ""}`}
                onValueChange={([v]) =>
                  adjustEdit.preview(setAdjust({ [a.key]: (v ?? 0) / a.scale }))
                }
                onValueCommit={([v]) =>
                  adjustEdit.commit(setAdjust({ [a.key]: v ? v / a.scale : undefined }))
                }
                onDoubleClick={() => adjustEdit.apply(setAdjust({ [a.key]: undefined }))}
              />
            </Row>
          );
        })}
      </InspectorSection>
      <MagicEdits disabled={disabled} />
    </>
  );
}

/** AI image actions registered by the AI extension (`ai.*` commands); hidden when it is not installed. */
function MagicEdits({ disabled }: { disabled: boolean }) {
  const editor = useEditor();
  useRegistryVersion();
  const ids = ["ai.removeBackground", "ai.upscale", "ai.expand", "ai.inpaint", "ai.trace"].filter(
    (id) => editor.commands.get(id),
  );
  if (ids.length === 0) return null;
  return (
    <InspectorSection title="Magic edits">
      <div className="grid grid-cols-2 gap-1.5">
        {ids.map((id) => (
          <AiCommandButton key={id} id={id} disabled={disabled} />
        ))}
      </div>
    </InspectorSection>
  );
}

function AiCommandButton({ id, disabled }: { id: string; disabled: boolean }) {
  const editor = useEditor();
  const c = useCommand(id);
  const Icon = editor.commands.get(id)?.icon;
  return (
    <button
      type="button"
      disabled={disabled || !c.enabled}
      onClick={() => void c.run()}
      className="group flex h-9 cursor-pointer items-center gap-1.5 rounded-[8px] bg-surface-2 px-2 text-xs text-fg transition-[box-shadow,background-color] duration-200 hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:text-accent"
    >
      {Icon ? <Icon /> : null}
      <span className="truncate">{c.label.replace(/…$/, "")}</span>
    </button>
  );
}

function FilterTile({
  label,
  active,
  url,
  css,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  url: string | null;
  css: string;
  onClick: () => void;
  disabled: boolean;
}) {
  const style: CSSProperties = { filter: css };
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="group flex cursor-pointer flex-col items-center gap-1 outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          "block aspect-square w-full overflow-hidden rounded-[8px] border bg-surface-3 transition-[border-color,box-shadow] duration-150",
          active
            ? "border-accent shadow-[0_0_0_1px_var(--accent)]"
            : "border-line-subtle group-hover:border-line",
          "group-focus-visible:ring-2 group-focus-visible:ring-ring",
        )}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="size-full object-cover"
            style={style}
            draggable={false}
          />
        ) : null}
      </span>
      <span className={cn("text-[10px]", active ? "text-fg" : "text-fg-muted")}>{label}</span>
    </button>
  );
}

/** Signed URL of a design asset (for previews in the inspector). */
export function useAssetUrl(assetId: string | null): string | null {
  const editor = useEditor();
  const [url, setUrl] = useState<string | null>(null);
  const asset = assetId ? editor.design?.assets[assetId] : undefined;
  useEffect(() => {
    if (!asset) {
      setUrl(null);
      return;
    }
    let live = true;
    void editor.assets.urlFor(asset).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [editor, asset]);
  return url;
}
