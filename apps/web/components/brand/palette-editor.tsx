"use client";

import { contrastRatio, normalizeHex, readableTextColor } from "@desyn/schema";
import {
  ColorPicker,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
} from "@desyn/ui";
import { Plus, X } from "lucide-react";
import { WARM } from "@/components/dashboard/featured-presets";
import { useT } from "@/lib/i18n";

export const COLOR_ROLES = [
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
  "text",
  "muted",
  "success",
  "warning",
  "danger",
  "other",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export interface BrandColor {
  id?: string;
  name: string;
  value: string;
  role?: ColorRole;
}

/** Named brand colors with roles; each swatch opens the full color picker. */
export function PaletteEditor({
  value,
  onChange,
  max = 64,
  compact = false,
}: {
  value: BrandColor[];
  onChange: (value: BrandColor[]) => void;
  max?: number;
  compact?: boolean;
}) {
  const t = useT();
  const update = (index: number, patch: Partial<BrandColor>) =>
    onChange(value.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const add = () => {
    const color = (WARM[value.length % WARM.length] ?? "#ffb02e").toLowerCase();
    onChange([
      ...value,
      { name: t("brand.color.defaultName", { n: value.length + 1 }), value: color, role: "other" },
    ]);
  };
  const roleOptions = COLOR_ROLES.map((r) => ({ value: r, label: t(`brand.color.roles.${r}`) }));

  return (
    <div
      className={
        compact
          ? "flex flex-wrap gap-3"
          : "grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3"
      }
    >
      {value.map((color, index) => {
        const hex = normalizeHex(color.value) ?? "#000000";
        const ratio = contrastRatio(hex, "#ffffff");
        return (
          <div
            key={color.id ?? `new-${index}`}
            className={compact ? "relative" : "group relative flex flex-col gap-2"}
          >
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t("brand.color.edit", { name: color.name })}
                  className={
                    compact
                      ? "size-14 cursor-pointer rounded-[12px] shadow-[inset_0_0_0_1px_rgb(var(--foreground-rgb)/0.12)] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      : "flex h-20 cursor-pointer items-end justify-between rounded-card p-3 text-left font-mono text-xs shadow-[inset_0_0_0_1px_rgb(var(--foreground-rgb)/0.08)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  }
                  style={{ background: hex, color: readableTextColor(hex) }}
                >
                  {compact ? null : (
                    <>
                      <span>{hex.toUpperCase()}</span>
                      <span className="opacity-70">
                        {t("brand.color.contrast", { ratio: ratio.toFixed(1) })}
                      </span>
                    </>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent flush className="w-[260px]" align="start">
                <ColorPicker
                  value={hex}
                  onChange={(next) => update(index, { value: next.slice(0, 7) })}
                  showAlpha={false}
                  brandColors={value.map((c) => c.value)}
                />
              </PopoverContent>
            </Popover>
            {compact ? (
              <button
                type="button"
                aria-label={t("brand.color.remove", { name: color.name })}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full bg-surface-3 text-fg-muted shadow hover:text-fg"
              >
                <X className="size-3" />
              </button>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1">
                  <Input
                    size="sm"
                    value={color.name}
                    maxLength={60}
                    aria-label={t("brand.color.name")}
                    onChange={(e) => update(index, { name: e.target.value })}
                  />
                  <IconButton
                    size="sm"
                    label={t("brand.color.remove", { name: color.name })}
                    onClick={() => onChange(value.filter((_, i) => i !== index))}
                  >
                    <X />
                  </IconButton>
                </div>
                <Select
                  size="sm"
                  options={roleOptions}
                  value={color.role ?? "other"}
                  onValueChange={(role) => update(index, { role })}
                  aria-label={t("brand.color.role")}
                />
              </div>
            )}
          </div>
        );
      })}
      {value.length < max ? (
        <button
          type="button"
          onClick={add}
          className={
            compact
              ? "grid size-14 cursor-pointer place-items-center rounded-[12px] bg-fg/[0.04] text-fg-muted transition-colors hover:bg-fg/[0.07] hover:text-fg"
              : "flex h-20 cursor-pointer items-center justify-center gap-2 rounded-card bg-fg/[0.04] text-sm text-fg-muted transition-colors hover:bg-fg/[0.07] hover:text-fg"
          }
          aria-label={t("brand.color.add")}
        >
          <Plus className="size-4" />
          {compact ? null : t("brand.color.add")}
        </button>
      ) : null}
    </div>
  );
}
