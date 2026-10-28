"use client";

import { cn } from "@desyn/ui";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

/**
 * Vertical splitter for the side panels (ARIA window splitter). Drag or use the arrow keys; double-click
 * resets. `side` is where the panel sits relative to the handle (`left`: dragging right grows it).
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  defaultValue,
  side,
  onChange,
  onCommit,
  controls,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  side: "left" | "right";
  onChange: (value: number) => void;
  onCommit?: () => void;
  controls: string;
}) {
  const drag = useRef<{ start: number; startValue: number; id: number } | null>(null);
  const [active, setActive] = useState(false);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const sign = side === "left" ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { start: e.clientX, startValue: value, id: e.pointerId };
    setActive(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    onChange(clamp(d.startValue + (e.clientX - d.start) * sign));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    setActive(false);
    onCommit?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onChange(clamp(value + (e.key === "ArrowRight" ? step : -step) * sign));
      onCommit?.();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      onChange(e.key === "Home" ? min : max);
      onCommit?.();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focusable or draggable (ARIA window splitter)
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={active || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onChange(defaultValue);
        onCommit?.();
      }}
      className={cn(
        "relative z-[2] w-px shrink-0 cursor-col-resize bg-line-subtle outline-none transition-colors duration-150",
        "hover:bg-accent/70 focus-visible:bg-accent data-[dragging]:bg-accent",
        "before:absolute before:inset-y-0 before:-right-1.5 before:-left-1.5 before:content-['']",
      )}
    />
  );
}
