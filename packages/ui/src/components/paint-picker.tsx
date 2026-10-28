"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { cssColor, parseColor, toHex } from "../lib/color.ts";
import {
  colorAt,
  convertPaint,
  type GradientPaint,
  type GradientStop,
  normalizeAngle,
  type Paint,
  type PaintType,
  paintToCss,
  sortStops,
  stopsToCss,
} from "../lib/gradient.ts";
import { focusRing } from "../lib/styles.ts";
import { IconButton } from "./button.tsx";
import { ColorPicker, type ColorPickerProps } from "./color-picker.tsx";
import { NumberField } from "./number-field.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { SegmentedControl } from "./toggle.tsx";

export type { GradientPaint, GradientStop, Paint, PaintType };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Pulling a stop this far off the bar removes it (when more than two remain). */
const REMOVE_DISTANCE = 36;

// ---------------------------------------------------------------------------------------------
// AngleDial
// ---------------------------------------------------------------------------------------------

export interface AngleDialProps {
  value: number;
  onChange: (deg: number) => void;
  onChangeEnd?: (deg: number) => void;
  label?: string;
  className?: string;
}

/** Circular angle control. Drag to rotate (Shift snaps to 15°); arrows ±1° (Shift ±15°). */
export function AngleDial({
  value,
  onChange,
  onChangeEnd,
  label = "Angle",
  className,
}: AngleDialProps) {
  const dragging = useRef<number | null>(null);
  const last = useRef(value);
  const fromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    // CSS gradient angles: 0deg points up, increasing clockwise.
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    const next = normalizeAngle(deg);
    last.current = next;
    onChange(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 : 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step;
    if (next === null) return;
    e.preventDefault();
    const n = normalizeAngle(next);
    onChange(n);
    onChangeEnd?.(n);
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} degrees`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus();
        dragging.current = e.pointerId;
        fromPointer(e);
      }}
      onPointerMove={(e) => dragging.current === e.pointerId && fromPointer(e)}
      onPointerUp={(e) => {
        if (dragging.current !== e.pointerId) return;
        dragging.current = null;
        onChangeEnd?.(last.current);
      }}
      className={cn(
        "relative size-8 shrink-0 cursor-grab touch-none rounded-full border border-line bg-surface-2 shadow-inset active:cursor-grabbing",
        focusRing,
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 h-[42%] w-0.5 origin-bottom -translate-x-1/2 -translate-y-full rounded-full bg-accent"
        style={{ rotate: `${value}deg` }}
      />
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-fg"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// GradientBar (stops editor)
// ---------------------------------------------------------------------------------------------

export interface GradientBarProps {
  stops: GradientStop[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onChange: (stops: GradientStop[], selectedIndex?: number) => void;
  onChangeEnd?: () => void;
  className?: string;
}

/**
 * The gradient preview bar with draggable stop handles. Click the bar to add a stop with the
 * interpolated color; drag a stop to move it, or pull it away to remove it. Each handle is a
 * slider: ←/→ move 1% (Shift 10%), Delete removes.
 */
export function GradientBar({
  stops,
  selectedIndex,
  onSelect,
  onChange,
  onChangeEnd,
  className,
}: GradientBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    index: number;
    pointerId: number;
    startY: number;
    removed: boolean;
  } | null>(null);

  const posFromX = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  };

  const addAt = (pos: number) => {
    const color = colorAt(stops, pos);
    const next = [...stops, { pos: Math.round(pos * 1000) / 1000, color }];
    onChange(next, next.length - 1);
    onChangeEnd?.();
  };

  const remove = (index: number) => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, i) => i !== index);
    onChange(next, Math.max(0, Math.min(index, next.length - 1)));
    onChangeEnd?.();
  };

  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    const stop = stops[index];
    if (!stop) return;
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const pos = clamp01(stop.pos + (e.key === "ArrowRight" ? step : -step));
      onChange(
        stops.map((s, i) => (i === index ? { ...s, pos: Math.round(pos * 1000) / 1000 } : s)),
      );
      onChangeEnd?.();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(index);
    }
  };

  return (
    <div className={cn("relative pt-1 pb-4", className)}>
      <div
        ref={barRef}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget || e.button !== 0) return;
          addAt(posFromX(e.clientX));
        }}
        className="dsn-checker relative h-6 cursor-copy rounded-[6px] shadow-[inset_0_0_0_1px_var(--line-subtle)]"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit]"
          style={{ background: stopsToCss(stops) }}
        />
      </div>
      {stops.map((stop, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: stops are edited positionally; indexes are the identity
          key={i}
          role="slider"
          tabIndex={0}
          aria-label={`Gradient stop ${i + 1}, ${stop.color}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(stop.pos * 100)}
          aria-valuetext={`${Math.round(stop.pos * 100)}%`}
          data-selected={i === selectedIndex || undefined}
          onFocus={() => onSelect(i)}
          onKeyDown={(e) => onHandleKey(e, i)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            e.currentTarget.focus();
            onSelect(i);
            drag.current = { index: i, pointerId: e.pointerId, startY: e.clientY, removed: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.pointerId !== e.pointerId || d.removed) return;
            if (Math.abs(e.clientY - d.startY) > REMOVE_DISTANCE && stops.length > 2) {
              d.removed = true;
              remove(d.index);
              return;
            }
            const pos = Math.round(posFromX(e.clientX) * 1000) / 1000;
            onChange(stops.map((s, j) => (j === d.index ? { ...s, pos } : s)));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            if (!d || d.pointerId !== e.pointerId) return;
            drag.current = null;
            if (!d.removed) onChangeEnd?.();
          }}
          className={cn(
            "absolute top-[22px] flex -translate-x-1/2 cursor-grab touch-none flex-col items-center active:cursor-grabbing",
            focusRing,
            "rounded-[5px]",
          )}
          style={{ left: `${stop.pos * 100}%` }}
        >
          <span
            aria-hidden
            className={cn(
              "size-0 border-x-[5px] border-b-[5px] border-x-transparent",
              i === selectedIndex ? "border-b-accent" : "border-b-fg/60",
            )}
          />
          <span
            aria-hidden
            className={cn(
              "dsn-checker size-4 overflow-hidden rounded-[4px] border-2 shadow-[0_1px_3px_rgb(0_0_0/0.4)]",
              i === selectedIndex ? "border-accent" : "border-white",
            )}
          >
            <span className="block size-full" style={{ background: cssColor(stop.color) }} />
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// PaintPicker
// ---------------------------------------------------------------------------------------------

const TYPE_OPTIONS: { value: PaintType; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "conic", label: "Conic" },
];

export interface PaintPickerProps
  extends Pick<
    ColorPickerProps,
    "documentColors" | "brandColors" | "swatches" | "eyeDropperFallback" | "showAlpha"
  > {
  value: Paint;
  /** Live updates while dragging. */
  onChange: (paint: Paint) => void;
  /** Once per gesture (commit a transaction here). */
  onChangeEnd?: (paint: Paint) => void;
  /** Paint types offered (default all). */
  types?: PaintType[];
  className?: string;
}

/**
 * Solid + gradient editor: type switcher, gradient stops bar, angle dial (linear/conic), stop
 * position, center (radial/conic) and radii (radial), and the full `ColorPicker` for the selected
 * stop. Values follow the document model's
 * `Fill` shapes.
 */
export function PaintPicker({
  value,
  onChange,
  onChangeEnd,
  types = ["solid", "linear", "radial", "conic"],
  className,
  ...colorProps
}: PaintPickerProps) {
  const [selected, setSelected] = useState(0);
  const latest = useRef(value);
  latest.current = value;
  const emit = (p: Paint) => {
    latest.current = p;
    onChange(p);
  };
  const end = () => onChangeEnd?.(latest.current);

  const isGradient = value.type !== "solid";
  const stops = isGradient ? value.stops : [];
  const sel = Math.min(selected, Math.max(0, stops.length - 1));
  const selectedStop = stops[sel];

  const setStops = (next: GradientStop[], selectIndex?: number) => {
    if (value.type === "solid") return;
    emit({ ...value, stops: next } as GradientPaint);
    if (selectIndex !== undefined) setSelected(selectIndex);
  };

  const options = TYPE_OPTIONS.filter((o) => types.includes(o.value));

  return (
    <div className={cn("flex w-[248px] flex-col gap-3", className)}>
      {options.length > 1 ? (
        <SegmentedControl
          aria-label="Paint type"
          size="sm"
          fullWidth
          options={options}
          value={value.type}
          onValueChange={(t) => {
            const next = convertPaint(value, t);
            emit(next);
            onChangeEnd?.(next);
            setSelected(0);
          }}
        />
      ) : null}

      {isGradient ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-medium text-fg-muted">Stops</span>
            <div className="flex items-center gap-0.5">
              <IconButton
                label="Add stop"
                size="xs"
                onClick={() => {
                  const pos = largestGapMidpoint(stops);
                  setStops([...stops, { pos, color: colorAt(stops, pos) }], stops.length);
                  end();
                }}
              >
                <Plus />
              </IconButton>
              <IconButton
                label="Reverse stops"
                size="xs"
                onClick={() => {
                  setStops(
                    sortStops(stops)
                      .map((s) => ({ ...s, pos: Math.round((1 - s.pos) * 1000) / 1000 }))
                      .reverse(),
                  );
                  end();
                }}
              >
                <ReverseIcon />
              </IconButton>
              <IconButton
                label="Remove stop"
                size="xs"
                disabled={stops.length <= 2}
                onClick={() => {
                  if (stops.length <= 2) return;
                  setStops(
                    stops.filter((_, i) => i !== sel),
                    Math.max(0, sel - 1),
                  );
                  end();
                }}
              >
                <Trash2 />
              </IconButton>
            </div>
          </div>
          <GradientBar
            stops={stops}
            selectedIndex={sel}
            onSelect={setSelected}
            onChange={setStops}
            onChangeEnd={end}
          />
          <div className="flex items-center gap-1.5">
            <NumberField
              aria-label="Stop position"
              label="Pos"
              size="sm"
              unit="%"
              min={0}
              max={100}
              value={selectedStop ? Math.round(selectedStop.pos * 100) : 0}
              onChange={(n) =>
                setStops(stops.map((s, i) => (i === sel ? { ...s, pos: n / 100 } : s)))
              }
              onChangeEnd={end}
              className="min-w-0 flex-1"
            />
            {value.type === "linear" || value.type === "conic" ? (
              <>
                <NumberField
                  aria-label="Angle"
                  label="Ang"
                  size="sm"
                  unit="°"
                  min={-360}
                  max={720}
                  value={value.angle}
                  onChange={(n) => emit({ ...value, angle: normalizeAngle(n) })}
                  onChangeEnd={end}
                  className="min-w-0 flex-1"
                />
                <AngleDial
                  value={value.angle}
                  onChange={(deg) => emit({ ...value, angle: deg })}
                  onChangeEnd={end}
                />
              </>
            ) : null}
          </div>
          {value.type === "radial" || value.type === "conic" ? (
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField
                aria-label="Center X"
                label="X"
                size="sm"
                unit="%"
                min={0}
                max={100}
                value={Math.round(value.cx * 100)}
                onChange={(n) => emit({ ...value, cx: n / 100 })}
                onChangeEnd={end}
              />
              <NumberField
                aria-label="Center Y"
                label="Y"
                size="sm"
                unit="%"
                min={0}
                max={100}
                value={Math.round(value.cy * 100)}
                onChange={(n) => emit({ ...value, cy: n / 100 })}
                onChangeEnd={end}
              />
              {value.type === "radial" ? (
                <>
                  <NumberField
                    aria-label="Radius X"
                    label="RX"
                    size="sm"
                    unit="%"
                    min={1}
                    max={200}
                    value={Math.round(value.rx * 100)}
                    onChange={(n) => emit({ ...value, rx: n / 100 })}
                    onChangeEnd={end}
                  />
                  <NumberField
                    aria-label="Radius Y"
                    label="RY"
                    size="sm"
                    unit="%"
                    min={1}
                    max={200}
                    value={Math.round(value.ry * 100)}
                    onChange={(n) => emit({ ...value, ry: n / 100 })}
                    onChangeEnd={end}
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <ColorPicker
        {...colorProps}
        value={value.type === "solid" ? value.color : (selectedStop?.color ?? "#000000")}
        onChange={(hex) => {
          if (value.type === "solid") emit({ type: "solid", color: hex });
          else setStops(stops.map((s, i) => (i === sel ? { ...s, color: hex } : s)));
        }}
        onChangeEnd={end}
        className="w-full"
      />
    </div>
  );
}

/** Midpoint of the widest gap between sorted stops (where a new stop is most useful). */
export function largestGapMidpoint(stops: GradientStop[]): number {
  const sorted = sortStops(stops);
  let best = { gap: -1, mid: 0.5 };
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a && b && b.pos - a.pos > best.gap) best = { gap: b.pos - a.pos, mid: (a.pos + b.pos) / 2 };
  }
  return Math.round(best.mid * 1000) / 1000;
}

function ReverseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 7h11l-3-3M17 17H6l3 3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// PaintSwatchButton: inspector trigger
// ---------------------------------------------------------------------------------------------

export interface PaintSwatchButtonProps extends Omit<PaintPickerProps, "className"> {
  /** Accessible name, e.g. "Fill color". */
  label: string;
  /** Show the hex/gradient description next to the chip. */
  showValue?: boolean;
  /**
   * Preferred side for the picker (default `left`, beside a right-hand inspector). Falls back to
   * opening below when there is no room beside the trigger.
   */
  side?: "top" | "right" | "bottom" | "left";
  /** Extra content inside the trigger (e.g. opacity). */
  children?: ReactNode;
  className?: string;
}

function describePaint(paint: Paint): string {
  if (paint.type === "solid") {
    const c = parseColor(paint.color);
    return c
      ? toHex({ ...c, a: 1 })
          .slice(1)
          .toUpperCase()
      : paint.color;
  }
  return `${paint.type[0]?.toUpperCase()}${paint.type.slice(1)}`;
}

/** Width of the picker popover (248 px content + padding + border). */
const PICKER_WIDTH = 276;

/**
 * Keeps a horizontal placement only when the picker fits beside the trigger (on either side, since
 * the popover can flip); otherwise opens above/below, e.g. in a full-width mobile inspector sheet.
 */
function fitSide(side: PopoverSide, trigger: HTMLElement | null): PopoverSide {
  if ((side !== "left" && side !== "right") || !trigger || typeof window === "undefined")
    return side;
  const rect = trigger.getBoundingClientRect();
  const room = Math.max(rect.left, window.innerWidth - rect.right);
  return room >= PICKER_WIDTH + 8 ? side : "bottom";
}

type PopoverSide = "top" | "right" | "bottom" | "left";

/** Inspector-style chip + value that opens a `PaintPicker` in a popover. */
export function PaintSwatchButton({
  label,
  showValue = true,
  side = "left",
  children,
  className,
  ...pickerProps
}: PaintSwatchButtonProps) {
  const paint = pickerProps.value;
  const alpha = paint.type === "solid" ? (parseColor(paint.color)?.a ?? 1) : null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState(side);
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setPlacement(fitSide(side, triggerRef.current));
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${label}: ${describePaint(paint)}`}
          className={cn(
            "flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-control border border-line-subtle bg-surface-2 pr-2 pl-1 text-xs text-fg shadow-inset transition-colors hover:border-line data-[state=open]:border-transparent data-[state=open]:ring-2 data-[state=open]:ring-ring",
            focusRing,
            className,
          )}
        >
          <span className="dsn-checker size-5 shrink-0 overflow-hidden rounded-[4px] shadow-[inset_0_0_0_1px_var(--line-subtle)]">
            <span className="block size-full" style={{ background: paintToCss(paint) }} />
          </span>
          {showValue ? (
            <span className="truncate font-mono text-[11px]">{describePaint(paint)}</span>
          ) : null}
          {alpha !== null && alpha < 1 ? (
            <span className="ml-auto text-2xs text-fg-muted tabular-nums">
              {Math.round(alpha * 100)}%
            </span>
          ) : null}
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        flush
        side={placement}
        align="start"
        // Dense controls need a calmer backdrop than menus.
        className="bg-surface-1/95 p-3"
        aria-label={label}
      >
        <PaintPicker {...pickerProps} />
      </PopoverContent>
    </Popover>
  );
}
