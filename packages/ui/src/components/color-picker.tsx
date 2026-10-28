"use client";

import { defaultSwatches } from "@desyn/tokens";
import { Pipette } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import {
  type ColorFormat,
  cssColor,
  formatColor,
  type Hsva,
  hslToRgb,
  hsvToRgb,
  isLight,
  oklchToRgb,
  parseColor,
  type Rgba,
  rgbToHsl,
  rgbToHsv,
  rgbToOklch,
  sameColor,
  toHex,
} from "../lib/color.ts";
import { isStringArray } from "../lib/storage.ts";
import { focusRing } from "../lib/styles.ts";
import { usePersistentState } from "../lib/use-persistent-state.ts";
import { IconButton } from "./button.tsx";
import { Input } from "./input.tsx";
import { NumberField } from "./number-field.tsx";
import { Select } from "./select.tsx";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Pointer drag helper: calls `onMove` with 0..1 coordinates inside `el`, `onEnd` on release. */
function usePointerDrag(onMove: (x: number, y: number) => void, onEnd: () => void) {
  const dragging = useRef<number | null>(null);
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0;
    const y = rect.height ? clamp((e.clientY - rect.top) / rect.height, 0, 1) : 0;
    onMove(x, y);
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.currentTarget.focus();
      dragging.current = e.pointerId;
      move(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (dragging.current === e.pointerId) move(e);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      if (dragging.current !== e.pointerId) return;
      dragging.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      onEnd();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ColorArea (saturation x value)
// ---------------------------------------------------------------------------------------------

export interface ColorAreaProps {
  hsva: Hsva;
  onChange: (hsva: Hsva) => void;
  onChangeEnd?: () => void;
  className?: string;
}

/** 2D saturation/brightness field. Arrow keys adjust by 1% (Shift: 10%). */
export function ColorArea({ hsva, onChange, onChangeEnd, className }: ColorAreaProps) {
  const drag = usePointerDrag(
    (x, y) => onChange({ ...hsva, s: x, v: 1 - y }),
    () => onChangeEnd?.(),
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    onChange({ ...hsva, s: clamp(hsva.s + d[0], 0, 1), v: clamp(hsva.v + d[1], 0, 1) });
    onChangeEnd?.();
  };
  const pure = toHex(hsvToRgb({ h: hsva.h, s: 1, v: 1, a: 1 }));
  const current = toHex(hsvToRgb({ ...hsva, a: 1 }));
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Saturation and brightness"
      aria-roledescription="2D slider"
      aria-valuenow={Math.round(hsva.s * 100)}
      aria-valuetext={`Saturation ${Math.round(hsva.s * 100)}%, brightness ${Math.round(hsva.v * 100)}%`}
      onKeyDown={onKeyDown}
      {...drag}
      className={cn(
        "relative h-40 w-full cursor-crosshair touch-none rounded-card shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]",
        focusRing,
        className,
      )}
      style={{
        background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})`,
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute size-4 -translate-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.35),0_2px_6px_rgb(0_0_0/0.4)]"
        style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%`, background: current }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// ChannelSlider (hue / alpha strips)
// ---------------------------------------------------------------------------------------------

export interface ChannelSliderProps {
  label: string;
  /** 0..1 position. */
  value: number;
  onChange: (value: number) => void;
  onChangeEnd?: () => void;
  /** CSS background of the track. */
  background: string;
  /** Show a transparency checkerboard under the track. */
  checker?: boolean;
  /** Thumb fill. */
  thumbColor: string;
  valueText: string;
  /** Keyboard step as a fraction (default 1/360 for hue-like precision). */
  step?: number;
  className?: string;
}

/** Thin gradient strip with a round thumb; arrow keys step, Shift steps x10. */
export function ChannelSlider({
  label,
  value,
  onChange,
  onChangeEnd,
  background,
  checker,
  thumbColor,
  valueText,
  step = 0.01,
  className,
}: ChannelSliderProps) {
  const drag = usePointerDrag(
    (x) => onChange(x),
    () => onChangeEnd?.(),
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const inc = e.shiftKey ? step * 10 : step;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + inc;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - inc;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next, 0, 1));
    onChangeEnd?.();
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={valueText}
      onKeyDown={onKeyDown}
      {...drag}
      className={cn(
        "relative h-3 w-full cursor-pointer touch-none rounded-full",
        checker && "dsn-checker",
        focusRing,
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-0 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]"
        style={{ background }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 size-3.5 -translate-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.3),0_1px_4px_rgb(0_0_0/0.4)]"
        style={{ left: `${clamp(value, 0, 1) * 100}%`, background: thumbColor }}
      />
    </div>
  );
}

const HUE_GRADIENT =
  "linear-gradient(to right, #ff0000, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000)";

// ---------------------------------------------------------------------------------------------
// Eyedropper
// ---------------------------------------------------------------------------------------------

interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperInstance {
  open: (options?: { signal?: AbortSignal }) => Promise<EyeDropperResult>;
}
type EyeDropperCtor = new () => EyeDropperInstance;

/** Whether the native EyeDropper API is available (Chromium). */
export function hasEyeDropper(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper === "function"
  );
}

export interface EyeDropperButtonProps {
  onPick: (hex: string) => void;
  /**
   * Called when the EyeDropper API is unavailable (Safari/Firefox). The editor can sample its own
   * canvas here; resolve with a color or `null`. Without it the native color input is used.
   */
  fallback?: () => Promise<string | null>;
  className?: string;
}

/** Picks a color from the screen with the EyeDropper API, falling back gracefully. */
export function EyeDropperButton({ onPick, fallback, className }: EyeDropperButtonProps) {
  const nativeRef = useRef<HTMLInputElement>(null);
  const pick = async () => {
    if (hasEyeDropper()) {
      try {
        const Ctor = (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
        const result = await new Ctor().open();
        const parsed = parseColor(result.sRGBHex);
        if (parsed) onPick(toHex(parsed));
      } catch {
        // User dismissed the eyedropper (Escape): nothing to do.
      }
      return;
    }
    if (fallback) {
      const picked = await fallback();
      const parsed = picked ? parseColor(picked) : null;
      if (parsed) onPick(toHex(parsed));
      return;
    }
    nativeRef.current?.click();
  };
  return (
    <>
      <IconButton label="Pick color from screen" size="sm" onClick={pick} className={className}>
        <Pipette />
      </IconButton>
      {!hasEyeDropper() && !fallback ? (
        <input
          ref={nativeRef}
          type="color"
          tabIndex={-1}
          aria-hidden
          className="sr-only"
          onChange={(e) => onPick(e.target.value.toLowerCase())}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Swatches
// ---------------------------------------------------------------------------------------------

export interface SwatchProps {
  color: string;
  selected?: boolean;
  onSelect?: (color: string) => void;
  size?: "sm" | "md";
  label?: string;
  className?: string;
}

/** A clickable color chip (checkerboard behind translucent colors). */
export function Swatch({ color, selected, onSelect, size = "md", label, className }: SwatchProps) {
  const rgba = parseColor(color);
  const light = rgba ? isLight(rgba) : false;
  return (
    <button
      type="button"
      aria-label={label ?? color}
      aria-pressed={selected}
      onClick={() => onSelect?.(color)}
      className={cn(
        "dsn-checker relative shrink-0 cursor-pointer overflow-hidden rounded-[5px] transition-transform duration-150 ease-out hover:scale-110",
        size === "sm" ? "size-4" : "size-5",
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-surface-1",
        focusRing,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-[inherit]",
          light
            ? "shadow-[inset_0_0_0_1px_rgb(0_0_0/0.14)]"
            : "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]",
        )}
        style={{ background: cssColor(color) }}
      />
    </button>
  );
}

export interface SwatchGroup {
  id: string;
  label: string;
  colors: string[];
}

function SwatchRow({
  group,
  value,
  onSelect,
}: {
  group: SwatchGroup;
  value: string;
  onSelect: (c: string) => void;
}) {
  if (group.colors.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics and default chrome
    <div role="group" aria-label={group.label} className="flex flex-col gap-1.5">
      <span className="text-2xs font-medium text-fg-muted">{group.label}</span>
      <div className="flex flex-wrap gap-1.5">
        {group.colors.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: palettes may repeat a color
          <Swatch key={`${c}-${i}`} color={c} selected={sameColor(c, value)} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

const RECENT_KEY = "desyn-recent-colors";
const RECENT_MAX = 14;

const NO_COLORS: string[] = [];

/** Recently used colors, persisted per browser and shared by every picker (hydration-safe). */
export function useRecentColors(max = RECENT_MAX): [string[], (color: string) => void] {
  const [recent, setRecent] = usePersistentState(RECENT_KEY, isStringArray, NO_COLORS);
  const latest = useRef(recent);
  latest.current = recent;
  const push = useCallback(
    (color: string) => {
      const prev = latest.current;
      const next = [color, ...prev.filter((c) => !sameColor(c, color))].slice(0, max);
      latest.current = next;
      setRecent(next);
    },
    [max, setRecent],
  );
  return [recent, push];
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const FORMAT_OPTIONS: { value: ColorFormat; label: string }[] = [
  { value: "hex", label: "Hex" },
  { value: "rgb", label: "RGB" },
  { value: "hsl", label: "HSL" },
  { value: "oklch", label: "OKLCH" },
];

export interface ColorInputsProps {
  rgba: Rgba;
  onChange: (rgba: Rgba) => void;
  /** Once per edit (Enter/blur, scrub release, arrow step). */
  onChangeEnd?: () => void;
  format: ColorFormat;
  onFormatChange: (format: ColorFormat) => void;
  showAlpha?: boolean;
}

/** Format selector plus per-channel fields (scrubbable) for hex / rgb / hsl / oklch. */
export function ColorInputs({
  rgba,
  onChange,
  onChangeEnd,
  format,
  onFormatChange,
  showAlpha = true,
}: ColorInputsProps) {
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const alpha = (
    <NumberField
      aria-label="Alpha"
      size="sm"
      value={Math.round(rgba.a * 100)}
      min={0}
      max={100}
      unit="%"
      onChange={(v) => onChange({ ...rgba, a: v / 100 })}
      onChangeEnd={onChangeEnd}
      className="w-[64px] shrink-0"
    />
  );
  let fields: ReactNode;
  if (format === "hex") {
    const hex = toHex({ ...rgba, a: 1 })
      .slice(1)
      .toUpperCase();
    const commit = () => {
      if (hexDraft === null) return;
      const parsed = parseColor(hexDraft);
      setHexDraft(null);
      if (!parsed) return;
      onChange({ ...parsed, a: hexDraft.replace("#", "").length === 8 ? parsed.a : rgba.a });
      onChangeEnd?.();
    };
    fields = (
      <Input
        size="sm"
        aria-label="Hex color"
        value={hexDraft ?? hex}
        leading={<span className="text-2xs">#</span>}
        spellCheck={false}
        maxLength={9}
        onChange={(e) => setHexDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setHexDraft(null);
        }}
        inputClassName="font-mono text-xs uppercase"
        className="min-w-0 flex-1"
      />
    );
  } else {
    const channels: {
      label: string;
      value: number;
      max: number;
      step?: number;
      unit?: string;
      precision?: number;
      set: (n: number) => Rgba;
    }[] =
      format === "rgb"
        ? [
            { label: "R", value: rgba.r, max: 255, set: (n) => ({ ...rgba, r: n }) },
            { label: "G", value: rgba.g, max: 255, set: (n) => ({ ...rgba, g: n }) },
            { label: "B", value: rgba.b, max: 255, set: (n) => ({ ...rgba, b: n }) },
          ]
        : format === "hsl"
          ? (() => {
              const hsl = rgbToHsl(rgba);
              return [
                {
                  label: "H",
                  value: Math.round(hsl.h),
                  max: 360,
                  unit: "°",
                  set: (n: number) => hslToRgb({ ...hsl, h: n }),
                },
                {
                  label: "S",
                  value: Math.round(hsl.s * 100),
                  max: 100,
                  set: (n: number) => hslToRgb({ ...hsl, s: n / 100 }),
                },
                {
                  label: "L",
                  value: Math.round(hsl.l * 100),
                  max: 100,
                  set: (n: number) => hslToRgb({ ...hsl, l: n / 100 }),
                },
              ];
            })()
          : (() => {
              const ok = rgbToOklch(rgba);
              return [
                {
                  label: "L",
                  value: Math.round(ok.l * 1000) / 10,
                  max: 100,
                  step: 0.5,
                  precision: 1,
                  set: (n: number) => oklchToRgb({ ...ok, l: n / 100 }),
                },
                {
                  label: "C",
                  value: Math.round(ok.c * 1000) / 1000,
                  max: 0.4,
                  step: 0.005,
                  precision: 3,
                  set: (n: number) => oklchToRgb({ ...ok, c: n }),
                },
                {
                  label: "H",
                  value: Math.round(ok.h),
                  max: 360,
                  set: (n: number) => oklchToRgb({ ...ok, h: n }),
                },
              ];
            })();
    fields = (
      <div className="flex min-w-0 flex-1 gap-1">
        {channels.map((ch) => (
          <NumberField
            key={`${format}-${ch.label}`}
            label={ch.label}
            size="sm"
            value={ch.value}
            min={0}
            max={ch.max}
            step={ch.step ?? 1}
            precision={ch.precision ?? 0}
            onChange={(n) => onChange({ ...ch.set(n), a: rgba.a })}
            onChangeEnd={onChangeEnd}
            className="min-w-0 flex-1"
            inputClassName="text-xs"
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Select
        aria-label="Color format"
        size="sm"
        value={format}
        onValueChange={onFormatChange}
        options={FORMAT_OPTIONS}
        className="w-[76px] shrink-0"
      />
      {fields}
      {showAlpha ? alpha : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// ColorPicker
// ---------------------------------------------------------------------------------------------

export interface ColorPickerProps {
  /** `#rrggbb` or `#rrggbbaa` (any CSS color string the parser accepts). */
  value: string;
  /** Live changes while dragging (canonical lowercase hex). */
  onChange: (hex: string) => void;
  /** Once per gesture; also records the color in recents. */
  onChangeEnd?: (hex: string) => void;
  showAlpha?: boolean;
  /** Colors used in the current document. */
  documentColors?: string[];
  /** Colors from the active brand kit. */
  brandColors?: string[];
  /** Extra palettes. Defaults to the Desyn default swatches. */
  swatches?: SwatchGroup[];
  /** Hide the recent colors row. */
  hideRecent?: boolean;
  /** Initial input format. */
  defaultFormat?: ColorFormat;
  /** Eyedropper fallback for browsers without the EyeDropper API (sample the canvas). */
  eyeDropperFallback?: () => Promise<string | null>;
  className?: string;
}

/**
 * Full color picker: HSV field, hue and alpha strips, eyedropper, hex/rgb/hsl/oklch inputs and
 * swatch rows (brand, document, recent, defaults). Works on HSV internally so hue survives
 * passing through greys.
 */
export function ColorPicker({
  value,
  onChange,
  onChangeEnd,
  showAlpha = true,
  documentColors,
  brandColors,
  swatches,
  hideRecent = false,
  defaultFormat = "hex",
  eyeDropperFallback,
  className,
}: ColorPickerProps) {
  const [hsva, setHsva] = useState<Hsva>(() =>
    rgbToHsv(parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 }),
  );
  const [format, setFormat] = useState<ColorFormat>(defaultFormat);
  const [recent, pushRecent] = useRecentColors();
  const lastEmitted = useRef<string | null>(null);
  // Latest emitted color, read by `end` which can run before React re-renders.
  const latestHex = useRef(toHex(hsvToRgb(hsva)));

  // Adopt external changes, but keep our HSV (and its hue) when the value is what we just emitted.
  useEffect(() => {
    const parsed = parseColor(value);
    if (!parsed) return;
    const hex = toHex(parsed);
    if (hex === lastEmitted.current) return;
    latestHex.current = hex;
    setHsva((prev) => {
      const next = rgbToHsv(parsed);
      // Greys and black have no hue/saturation; keep the previous ones so the field doesn't jump.
      if (next.v === 0) return { ...prev, v: 0, a: next.a };
      if (next.s === 0) return { ...prev, s: 0, v: next.v, a: next.a };
      return next;
    });
  }, [value]);

  const hex = toHex(hsvToRgb(hsva));
  const update = (next: Hsva) => {
    setHsva(next);
    const out = toHex(hsvToRgb(showAlpha ? next : { ...next, a: 1 }));
    lastEmitted.current = out;
    latestHex.current = out;
    onChange(out);
  };
  const end = () => {
    onChangeEnd?.(latestHex.current);
    pushRecent(latestHex.current);
  };
  const setFromRgba = (rgba: Rgba) => {
    const next = rgbToHsv(rgba);
    update(next.s === 0 || next.v === 0 ? { ...hsva, s: next.s, v: next.v, a: next.a } : next);
  };
  const pickSwatch = (color: string) => {
    const raw = parseColor(color);
    if (!raw) return;
    const parsed = showAlpha ? raw : { ...raw, a: 1 };
    const next = rgbToHsv(parsed);
    setHsva(next);
    const out = toHex(parsed);
    lastEmitted.current = out;
    latestHex.current = out;
    onChange(out);
    onChangeEnd?.(out);
    pushRecent(out);
  };

  const rgba = hsvToRgb(hsva);
  const opaque = toHex({ ...rgba, a: 1 });
  const groups: SwatchGroup[] = [
    ...(brandColors?.length ? [{ id: "brand", label: "Brand", colors: brandColors }] : []),
    ...(documentColors?.length
      ? [{ id: "document", label: "Document", colors: documentColors }]
      : []),
    ...(!hideRecent && recent.length ? [{ id: "recent", label: "Recent", colors: recent }] : []),
    ...(swatches ?? [{ id: "default", label: "Swatches", colors: [...defaultSwatches] }]),
  ];

  return (
    <div className={cn("flex w-[248px] flex-col gap-3", className)}>
      <ColorArea hsva={hsva} onChange={update} onChangeEnd={end} />
      <div className="flex items-center gap-2">
        <EyeDropperButton onPick={pickSwatch} fallback={eyeDropperFallback} />
        <div className="flex flex-1 flex-col gap-2.5">
          <ChannelSlider
            label="Hue"
            value={hsva.h / 360}
            onChange={(x) => update({ ...hsva, h: x * 360 })}
            onChangeEnd={end}
            background={HUE_GRADIENT}
            thumbColor={toHex(hsvToRgb({ h: hsva.h, s: 1, v: 1, a: 1 }))}
            valueText={`${Math.round(hsva.h)} degrees`}
            step={1 / 360}
          />
          {showAlpha ? (
            <ChannelSlider
              label="Alpha"
              value={hsva.a}
              onChange={(x) => update({ ...hsva, a: Math.round(x * 100) / 100 })}
              onChangeEnd={end}
              checker
              background={`linear-gradient(to right, ${opaque}00, ${opaque})`}
              thumbColor={hex}
              valueText={`${Math.round(hsva.a * 100)}%`}
            />
          ) : null}
        </div>
        <div className="dsn-checker size-8 shrink-0 overflow-hidden rounded-[8px] shadow-[inset_0_0_0_1px_var(--line-subtle)]">
          <div
            className="size-full"
            style={{ background: hex }}
            title={formatColor(rgba, format)}
          />
        </div>
      </div>
      <ColorInputs
        rgba={rgba}
        onChange={setFromRgba}
        onChangeEnd={end}
        format={format}
        onFormatChange={setFormat}
        showAlpha={showAlpha}
      />
      <div className="flex flex-col gap-3 border-t border-line-subtle pt-3">
        {groups.map((g) => (
          <SwatchRow key={g.id} group={g} value={hex} onSelect={pickSwatch} />
        ))}
      </div>
    </div>
  );
}
