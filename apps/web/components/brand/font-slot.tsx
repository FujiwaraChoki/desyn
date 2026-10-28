"use client";

import { FONT_CATALOG } from "@desyn/schema";
import { type FontOption, FontPickerButton, Select, Switch } from "@desyn/ui";
import { useEffect, useMemo } from "react";
import { loadGoogleFont } from "@/lib/fonts";
import { useT } from "@/lib/i18n";

export interface BrandFont {
  family: string;
  weight: number;
  style: "normal" | "italic";
  assetId?: string;
  fallback?: string;
}

export const FONT_OPTIONS: FontOption[] = FONT_CATALOG.map((f) => ({
  family: f.family,
  category: f.category,
  weights: f.weights,
  source: "Google",
}));

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

function fontStackFor(family: string): string {
  const info = FONT_CATALOG.find((f) => f.family === family);
  const fallback =
    info?.category === "serif"
      ? "Georgia, serif"
      : info?.category === "monospace"
        ? "monospace"
        : "system-ui, sans-serif";
  return `"${family.replace(/["\\]/g, "")}", ${fallback}`;
}

/** One brand font slot (heading / body / accent): family from the catalog, weight, italic, preview. */
export function FontSlot({
  label,
  value,
  onChange,
  sample,
}: {
  label: string;
  value: BrandFont | undefined;
  onChange: (value: BrandFont | undefined) => void;
  sample: string;
}) {
  const t = useT();
  const info = useMemo(() => FONT_CATALOG.find((f) => f.family === value?.family), [value?.family]);
  useEffect(() => {
    if (value?.family && !value.assetId) void loadGoogleFont(value.family, [value.weight]);
  }, [value?.family, value?.weight, value?.assetId]);
  const weights = info?.weights ?? [400, 700];
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-2xs font-medium text-fg-muted">{label}</span>
        {value ? (
          <button
            type="button"
            className="cursor-pointer text-2xs text-fg-muted hover:text-fg"
            onClick={() => onChange(undefined)}
          >
            {t("brand.font.clear")}
          </button>
        ) : null}
      </div>
      <p
        className="mb-3 min-h-[2.4em] text-[22px] leading-[1.2] text-fg"
        style={
          value
            ? {
                fontFamily: fontStackFor(value.family),
                fontWeight: value.weight,
                fontStyle: value.style,
              }
            : { color: "var(--fg-muted)" }
        }
      >
        {value ? sample : t("brand.font.none")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-44 flex-1">
          <FontPickerButton
            label={label}
            fonts={FONT_OPTIONS}
            value={value?.family}
            loadFont={(f) => loadGoogleFont(f.family, [400])}
            onChange={(family) => {
              const fi = FONT_CATALOG.find((f) => f.family === family);
              const w =
                value && fi?.weights.includes(value.weight)
                  ? value.weight
                  : fi?.weights.includes(400)
                    ? 400
                    : (fi?.weights[0] ?? 400);
              onChange({ family, weight: w, style: "normal" });
            }}
          />
        </div>
        {value ? (
          <>
            <Select
              size="md"
              className="w-36"
              aria-label={t("brand.font.weight")}
              options={weights.map((w) => ({
                value: String(w),
                label: `${WEIGHT_NAMES[w] ?? w} ${w}`,
              }))}
              value={String(value.weight)}
              onValueChange={(w) => onChange({ ...value, weight: Number(w) })}
            />
            {info?.italic ? (
              <Switch
                size="sm"
                label={t("brand.font.italic")}
                checked={value.style === "italic"}
                onCheckedChange={(on) => onChange({ ...value, style: on ? "italic" : "normal" })}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
