"use client";

import { cn, IconButton, Progress, Select, toast } from "@desyn/ui";
import { useConvex } from "convex/react";
import { ImagePlus, X } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import type { Id } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { mimeFor, uploadAsset } from "@/lib/upload";

export const LOGO_VARIANTS = [
  "primary",
  "secondary",
  "icon",
  "wordmark",
  "light",
  "dark",
  "other",
] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];

export interface BrandLogo {
  id?: string;
  assetId: Id<"assets">;
  name: string;
  variant: LogoVariant;
  /** Signed URL from the server, or a local object URL for logos uploaded in this session. */
  url?: string | null;
}

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

interface Pending {
  key: string;
  name: string;
  progress: number;
}

/** Logo variants of a brand kit: drag-and-drop upload to the asset library, variant per logo. */
export function LogoUploader({
  workspaceId,
  value,
  onChange,
  max = 20,
  single = false,
}: {
  workspaceId: Id<"workspaces">;
  value: BrandLogo[];
  onChange: (value: BrandLogo[]) => void;
  max?: number;
  single?: boolean;
}) {
  const t = useT();
  const convex = useConvex();
  const input = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);
  const latest = useRef(value);
  latest.current = value;

  const upload = async (files: File[]) => {
    const room = single ? 1 : Math.max(0, max - value.length);
    for (const file of files.slice(0, room)) {
      if (!IMAGE_TYPES.has(mimeFor(file))) {
        toast.error(t("brand.logo.unsupported", { name: file.name }));
        continue;
      }
      const key = `${file.name}-${file.size}-${Date.now()}`;
      setPending((p) => [...p, { key, name: file.name, progress: 0 }]);
      try {
        const result = await uploadAsset(convex, {
          workspaceId,
          file,
          source: "brand",
          onProgress: (progress) =>
            setPending((p) => p.map((x) => (x.key === key ? { ...x, progress } : x))),
        });
        const logo: BrandLogo = {
          assetId: result.assetId,
          name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 60) || "Logo",
          variant: latest.current.length === 0 ? "primary" : "other",
          url: URL.createObjectURL(file),
        };
        onChange(single ? [logo] : [...latest.current, logo]);
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setPending((p) => p.filter((x) => x.key !== key));
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void upload(Array.from(e.dataTransfer.files));
  };

  const variantOptions = LOGO_VARIANTS.map((v) => ({
    value: v,
    label: t(`brand.logo.variants.${v}`),
  }));
  const full = single ? value.length >= 1 : value.length >= max;

  return (
    <div className="flex flex-col gap-3">
      {value.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {value.map((logo, index) => (
            <li key={logo.id ?? logo.assetId} className="flex flex-col gap-1.5">
              <div
                className={cn(
                  "relative grid h-28 place-items-center overflow-hidden rounded-card p-4 shadow-[inset_0_0_0_1px_rgb(var(--foreground-rgb)/0.08)]",
                  logo.variant === "light"
                    ? "bg-[#111]"
                    : logo.variant === "dark"
                      ? "bg-white"
                      : "checker",
                )}
              >
                {logo.url ? (
                  // biome-ignore lint/performance/noImgElement: signed asset URLs and local blob previews
                  <img
                    src={logo.url}
                    alt={logo.name}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <span className="text-2xs text-fg-muted">{t("brand.logo.noPreview")}</span>
                )}
                <IconButton
                  size="xs"
                  variant="secondary"
                  label={t("brand.logo.remove", { name: logo.name })}
                  className="absolute top-2 right-2"
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <X />
                </IconButton>
              </div>
              {single ? null : (
                <div>
                  <Select
                    size="sm"
                    options={variantOptions}
                    value={logo.variant}
                    onValueChange={(variant) =>
                      onChange(value.map((l, i) => (i === index ? { ...l, variant } : l)))
                    }
                    aria-label={t("brand.logo.variant")}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {pending.map((p) => (
        <div key={p.key} className="flex items-center gap-3 text-xs text-fg-secondary">
          <span className="min-w-0 flex-1 truncate">
            {t("brand.logo.uploading", { name: p.name })}
          </span>
          <Progress
            className="w-28"
            value={Math.round(p.progress * 100)}
            size="sm"
            label={p.name}
          />
        </div>
      ))}
      {full ? null : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex cursor-pointer items-center justify-center gap-2 rounded-card px-4 py-4 text-sm transition-colors",
            over
              ? "bg-accent-wash text-fg ring-1 ring-accent/50"
              : "bg-fg/[0.04] text-fg-muted hover:bg-fg/[0.07] hover:text-fg-secondary",
          )}
        >
          <ImagePlus className={cn("size-4", over && "text-accent")} />
          {t("brand.logo.drop")}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        multiple={!single}
        className="hidden"
        onChange={(e) => {
          void upload(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </div>
  );
}
