"use client";

import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ARTBOARD, type DemoDesign, type DemoLayer } from "@/lib/demo/types";
import { Art } from "./Art";

const SPRING: Transition = { type: "spring", stiffness: 110, damping: 20, mass: 1 };
const INSTANT: Transition = { duration: 0 };

function solid(c: string | undefined) {
  return !c || c === "transparent" ? "rgba(0,0,0,0)" : c;
}

function ring(stroke: string | undefined, width: number | undefined) {
  return `inset 0 0 0 ${stroke && width ? width : 0}px ${solid(stroke)}`;
}

/** Reveals text like it is being typed, once, when a layer is first placed. */
function TypeIn({ text, animate }: { text: string; animate: boolean }) {
  const [count, setCount] = useState(animate ? 0 : text.length);
  const first = useRef(text);
  useEffect(() => {
    if (!animate || first.current !== text) {
      setCount(text.length);
      return;
    }
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= text.length) clearInterval(id);
    }, 28);
    return () => clearInterval(id);
  }, [animate, text]);
  return (
    <>
      {text.slice(0, count)}
      <span style={{ opacity: 0 }}>{text.slice(count)}</span>
    </>
  );
}

function LayerContent({ layer, uid, typing }: { layer: DemoLayer; uid: string; typing: boolean }) {
  if (layer.kind === "rect") {
    return (
      <div
        className="demo-bg h-full w-full"
        style={
          { "--demo-c1": layer.fill, "--demo-c2": layer.fill2 ?? layer.fill } as React.CSSProperties
        }
      />
    );
  }
  if (layer.kind === "ellipse") {
    return (
      <motion.div
        className="h-full w-full rounded-full"
        initial={false}
        animate={{
          backgroundColor: solid(layer.fill),
          boxShadow: ring(layer.stroke, layer.strokeWidth),
        }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      />
    );
  }
  if (layer.kind === "image" && layer.art) {
    const [a, b, c] = layer.artColors ?? ["#ccc", "#999", "#666"];
    return (
      <div
        className="demo-art h-full w-full"
        style={{ "--art-a": a, "--art-b": b, "--art-c": c } as React.CSSProperties}
      >
        <Art art={layer.art} uid={uid} />
      </div>
    );
  }
  const isButton = layer.kind === "button";
  return (
    <motion.div
      className={`flex h-full w-full ${isButton ? "items-center justify-center" : "items-start"}`}
      initial={false}
      animate={{
        color: layer.color ?? "#000",
        fontSize: layer.fontSize ?? 32,
        backgroundColor: isButton ? solid(layer.fill) : "rgba(0,0,0,0)",
        boxShadow: isButton ? ring(layer.stroke, layer.strokeWidth) : ring(undefined, 0),
        letterSpacing: `${layer.letterSpacing ?? 0}em`,
      }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      style={{
        borderRadius: layer.radius ?? 0,
        fontFamily: layer.font === "serif" ? "var(--font-serif)" : "var(--font-sans)",
        fontWeight: layer.font === "sans" ? (isButton ? 600 : 500) : 400,
        fontStyle: layer.italic ? "italic" : "normal",
        textTransform: layer.upper ? "uppercase" : "none",
        lineHeight: layer.lineHeight ?? 1.2,
        textAlign: layer.align ?? "left",
        justifyContent: isButton
          ? "center"
          : layer.align === "center"
            ? "center"
            : layer.align === "right"
              ? "flex-end"
              : "flex-start",
        whiteSpace: "pre-wrap",
        textWrap: "balance",
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={layer.text}
          className="block w-full"
          style={{ textAlign: isButton ? "center" : (layer.align ?? "left") }}
          initial={{ opacity: 0, filter: "blur(6px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, filter: "blur(6px)" }}
          transition={{ duration: 0.35 }}
        >
          <TypeIn text={layer.text ?? ""} animate={typing} />
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

function entrance(layer: DemoLayer) {
  switch (layer.role) {
    case "background":
      return { clipPath: "inset(100% 0% 0% 0%)" };
    case "decoration":
      return { scale: 0.35, opacity: 0 };
    case "photo":
      return { opacity: 0, scale: 1.08, filter: "blur(28px)" };
    case "cta":
      return { opacity: 0, scale: 0.7 };
    default:
      return { opacity: 0, y: layer.y + 36 };
  }
}

interface ArtboardProps {
  design: DemoDesign;
  placed: string[];
  selected: string | null;
  glow: string[];
  sweep: number;
  generating: boolean;
  reduced: boolean;
  onSelect: (id: string | null) => void;
  onBeginMove: () => void;
  onMove: (id: string, x: number, y: number, commit: boolean) => void;
  /** Reports the on-screen scale (for the zoom readout). */
  onScale?: (scale: number) => void;
}

export function Artboard({
  design,
  placed,
  selected,
  glow,
  sweep,
  generating,
  reduced,
  onSelect,
  onBeginMove,
  onMove,
  onScale,
}: ArtboardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<{
    id: string;
    px: number;
    py: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / ARTBOARD.width, r.height / ARTBOARD.height);
      setScale(s);
      onScale?.(s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onScale]);

  const layers = design.layers.filter((l) => placed.includes(l.id));
  const sel = layers.find((l) => l.id === selected);
  const w = ARTBOARD.width * scale;
  const h = ARTBOARD.height * scale;

  const onPointerDown = (e: React.PointerEvent, layer: DemoLayer) => {
    e.stopPropagation();
    onSelect(layer.id);
    if (layer.role === "background" || generating) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      id: layer.id,
      px: e.clientX,
      py: e.clientY,
      x: layer.x,
      y: layer.y,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || scale === 0) return;
    const dx = (e.clientX - d.px) / scale;
    const dy = (e.clientY - d.py) / scale;
    if (!d.moved && Math.hypot(dx, dy) * scale < 3) return;
    if (!d.moved) {
      d.moved = true;
      onBeginMove();
      setDragging(d.id);
    }
    onMove(d.id, d.x + dx, d.y + dy, false);
  };

  const onPointerUp = () => {
    drag.current = null;
    setDragging(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onSelect(null);
      return;
    }
    if (!sel || sel.role === "background" || generating) return;
    const step = e.shiftKey ? 50 : 10;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    onMove(sel.id, sel.x + d[0], sel.y + d[1], true);
  };

  return (
    <div ref={box} className="relative grid h-full w-full place-items-center">
      {scale > 0 && (
        <div
          role="application"
          aria-label="Design canvas. Click a layer to select it, drag to move, arrow keys nudge, Escape deselects."
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas takes keyboard input for nudging layers.
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={() => onSelect(null)}
          className="relative touch-none select-none rounded-[3px] outline-offset-4"
          style={{
            width: w,
            height: h,
            boxShadow: "0 30px 80px -30px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06)",
          }}
        >
          <div className="absolute inset-0 overflow-hidden rounded-[3px]">
            {placed.length === 0 && (
              <div className="absolute inset-0 grid place-items-center bg-[#fbf8f3] dark:bg-[#141210]">
                <div className="flex flex-col items-center gap-3 px-6 text-center">
                  <span className="sun-spinner opacity-0" />
                  <p className="font-serif text-[clamp(18px,2vw,24px)] leading-tight text-subtle">
                    Your design appears here,
                    <br />
                    layer by layer.
                  </p>
                </div>
              </div>
            )}
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{
                width: ARTBOARD.width,
                height: ARTBOARD.height,
                transform: `scale(${scale})`,
              }}
            >
              <AnimatePresence>
                {layers.map((l) => (
                  <motion.div
                    key={l.id}
                    data-layer={l.id}
                    className={`absolute left-0 top-0 ${l.role === "background" ? "" : "cursor-grab active:cursor-grabbing"}`}
                    initial={
                      reduced
                        ? false
                        : { x: l.x, y: l.y, width: l.width, height: l.height, ...entrance(l) }
                    }
                    animate={{
                      x: l.x,
                      y: l.y,
                      width: l.width,
                      height: l.height,
                      opacity: l.visible ? l.opacity : 0,
                      scale: 1,
                      filter: "blur(0px)",
                      clipPath: "inset(0% 0% 0% 0%)",
                    }}
                    exit={{ opacity: 0, transition: { duration: 0.3 } }}
                    transition={
                      dragging === l.id
                        ? INSTANT
                        : {
                            ...SPRING,
                            clipPath: { duration: 1, ease: [0.16, 1, 0.3, 1] },
                            filter: { duration: 1.1 },
                          }
                    }
                    onPointerDown={(e) => onPointerDown(e, l)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  >
                    <LayerContent layer={l} uid={`${uid}${l.id}`} typing={generating && !reduced} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            {sweep > 0 && !reduced && <div key={sweep} className="demo-sweep" />}
          </div>

          {/* Overlays live in screen space so handles and rings stay crisp at any zoom. */}
          {layers
            .filter((l) => glow.includes(l.id) && l.role !== "background")
            .map((l) => (
              <motion.div
                key={`glow-${l.id}`}
                className="pointer-events-none absolute left-0 top-0"
                initial={false}
                animate={{
                  x: l.x * scale,
                  y: l.y * scale,
                  width: l.width * scale,
                  height: l.height * scale,
                }}
                transition={dragging === l.id ? INSTANT : SPRING}
              >
                <div className="demo-glow" />
              </motion.div>
            ))}
          {sel && (
            <motion.div
              className="pointer-events-none absolute left-0 top-0"
              initial={false}
              animate={{
                x: sel.x * scale,
                y: sel.y * scale,
                width: sel.width * scale,
                height: sel.height * scale,
              }}
              transition={dragging === sel.id ? INSTANT : SPRING}
            >
              <div className="absolute inset-0 border border-sun" />
              {(
                [
                  "-left-1 -top-1",
                  "-right-1 -top-1",
                  "-left-1 -bottom-1",
                  "-right-1 -bottom-1",
                ] as const
              ).map((pos) => (
                <span key={pos} className={`demo-handle ${pos}`} />
              ))}
              <span className="absolute -top-6 left-0 whitespace-nowrap rounded-[4px] bg-sun px-1.5 py-0.5 font-mono text-[10px] leading-4 text-on-sun">
                {sel.name} · {Math.round(sel.width)} × {Math.round(sel.height)}
              </span>
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}
