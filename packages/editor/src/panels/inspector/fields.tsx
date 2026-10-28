"use client";

import { cn, NumberField, type NumberFieldProps, PaintSwatchButton } from "@desyn/ui";
import type { ReactNode } from "react";
import { useBrandColors } from "./brand-colors.ts";
import { useDocumentColors } from "./hooks.ts";

/**
 * Inspector inputs: numbers with a scrub label (`value === null` shows "Mixed" for multi-selections), a
 * percentage variant over 0..1 values, and single-color swatches wired to document + brand colors.
 */

export function Num({
  label,
  value,
  onLive,
  onCommit,
  className,
  ...rest
}: Omit<NumberFieldProps, "value" | "onChange" | "onChangeEnd" | "label"> & {
  label: ReactNode;
  value: number | null | undefined;
  onLive?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <NumberField
      size="sm"
      label={label}
      value={value === undefined ? null : value}
      placeholder={value === null ? "Mixed" : undefined}
      {...(onLive ? { onChange: onLive } : {})}
      onChangeEnd={onCommit}
      className={cn("min-w-0 flex-1", className)}
      {...rest}
    />
  );
}

/** 0..1 value edited as 0..100 %. */
export function Percent({
  label,
  value,
  onLive,
  onCommit,
  ...rest
}: Omit<Parameters<typeof Num>[0], "unit" | "min" | "max" | "value"> & {
  value: number | null | undefined;
}) {
  return (
    <Num
      label={label}
      unit="%"
      min={0}
      max={100}
      value={value === null || value === undefined ? value : Math.round(value * 1000) / 10}
      {...(onLive ? { onLive: (v: number) => onLive(v / 100) } : {})}
      onCommit={(v) => onCommit(v / 100)}
      {...rest}
    />
  );
}

/** A single solid color (QR colors, chart text, shadow colors). */
export function ColorSwatch({
  label,
  color,
  onLive,
  onCommit,
  showAlpha = true,
  showValue = true,
  className,
}: {
  label: string;
  color: string;
  onLive?: (hex: string) => void;
  onCommit: (hex: string) => void;
  showAlpha?: boolean;
  showValue?: boolean;
  className?: string;
}) {
  const documentColors = useDocumentColors();
  const brandColors = useBrandColors();
  return (
    <PaintSwatchButton
      label={label}
      showValue={showValue}
      showAlpha={showAlpha}
      types={["solid"]}
      value={{ type: "solid", color }}
      documentColors={documentColors}
      brandColors={brandColors}
      onChange={(p) => p.type === "solid" && onLive?.(p.color)}
      onChangeEnd={(p) => p.type === "solid" && onCommit(p.color)}
      className={cn("min-w-0 flex-1", className)}
    />
  );
}
