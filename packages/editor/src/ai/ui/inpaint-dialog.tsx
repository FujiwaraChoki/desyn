"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  SegmentedControl,
  Slider,
  Textarea,
} from "@desyn/ui";
import { Brush, Eraser, RotateCcw, Trash2 } from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ModalDef, ModalProps } from "../../shell/extensions.ts";
import { creditsFor } from "../core/prompt.ts";
import { imageTarget } from "../media.ts";
import { useAiSession } from "./hooks.ts";
import { AiActionButton } from "./parts.tsx";

interface Stroke {
  mode: "paint" | "erase";
  /** Brush diameter in image pixels. */
  size: number;
  points: { x: number; y: number }[];
}

const MAX_W = 720;
const MAX_H = 460;

/** Draws strokes onto a 2D context in image-pixel coordinates scaled by `scale`. */
function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  scale: number,
  color: string,
): void {
  for (const s of strokes) {
    ctx.globalCompositeOperation = s.mode === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = s.size * scale;
    const [first, ...rest] = s.points;
    if (!first) continue;
    if (rest.length === 0) {
      ctx.beginPath();
      ctx.arc(first.x * scale, first.y * scale, (s.size * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first.x * scale, first.y * scale);
    for (const p of rest) ctx.lineTo(p.x * scale, p.y * scale);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** The inpaint mask as PNG bytes at the image's pixel size: white = repaint, black = keep. */
export async function maskPng(strokes: Stroke[], width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the mask.");
  // Strokes go on a transparent layer first so erasing removes paint, not the black background.
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d");
  if (!lctx) throw new Error("This browser cannot draw the mask.");
  drawStrokes(lctx, strokes, 1, "#ffffff");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(layer, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("The mask could not be encoded."))),
      "image/png",
    ),
  );
}

function InpaintDialog({ editor, props, close }: ModalProps) {
  const session = useAiSession();
  const nodeId =
    typeof props.nodeId === "string" ? props.nodeId : (editor.getState().selection[0] ?? "");
  const design = editor.design;
  const target = design ? imageTarget(design, nodeId) : null;
  const naturalW = target?.ref.width ?? Math.round(target?.node.width ?? 1024);
  const naturalH = target?.ref.height ?? Math.round(target?.node.height ?? 1024);
  const scale = Math.min(MAX_W / naturalW, MAX_H / naturalH, 1);
  const displayW = Math.round(naturalW * scale);
  const displayH = Math.round(naturalH * scale);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<"paint" | "erase">("paint");
  const [brush, setBrush] = useState(Math.round(Math.max(naturalW, naturalH) / 18));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const drawing = useRef<Stroke | null>(null);

  const ref = target?.ref ?? null;
  useEffect(() => {
    if (!ref) return;
    let alive = true;
    void editor.assets.urlFor(ref).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [editor, ref]);

  const redraw = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayW, displayH);
    const all = drawing.current ? [...strokes, drawing.current] : strokes;
    drawStrokes(ctx, all, scale, "rgba(255, 176, 46, 0.55)");
  }, [strokes, scale, displayW, displayH]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(displayW * dpr);
    c.height = Math.round(displayH * dpr);
    redraw();
  }, [displayW, displayH, redraw]);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(naturalW, ((e.clientX - r.left) / r.width) * naturalW)),
      y: Math.max(0, Math.min(naturalH, ((e.clientY - r.top) / r.height) * naturalH)),
    };
  };

  const submit = async () => {
    if (!target || strokes.length === 0 || !prompt.trim()) return;
    setBusy(true);
    try {
      const mask = await maskPng(strokes, naturalW, naturalH);
      close();
      await session.inpaint(mask, prompt.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            repaint <em className="text-accent">an area</em>
          </DialogTitle>
          <DialogDescription>
            Brush over what should change, then describe what belongs there.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!target ? (
            <p className="py-8 text-center text-sm text-fg-muted">Select an image to repaint.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div
                className="dsn-ai-checker mx-auto overflow-hidden rounded-card border border-line-subtle"
                style={{ width: displayW, height: displayH }}
              >
                <div className="relative size-full">
                  {url ? (
                    <img
                      src={url}
                      alt={target.node.name}
                      className="absolute inset-0 size-full object-fill"
                      draggable={false}
                    />
                  ) : null}
                  <canvas
                    ref={canvas}
                    aria-label="Mask brush area"
                    className="absolute inset-0 size-full cursor-crosshair touch-none"
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      drawing.current = { mode, size: brush, points: [point(e)] };
                      redraw();
                    }}
                    onPointerMove={(e) => {
                      if (!drawing.current) return;
                      drawing.current.points.push(point(e));
                      redraw();
                    }}
                    onPointerUp={() => {
                      const s = drawing.current;
                      drawing.current = null;
                      if (s) setStrokes((all) => [...all, s]);
                    }}
                    onPointerCancel={() => {
                      drawing.current = null;
                      redraw();
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl
                  size="sm"
                  aria-label="Brush mode"
                  value={mode}
                  onValueChange={setMode}
                  options={[
                    {
                      value: "paint",
                      label: (
                        <>
                          <Brush /> Paint
                        </>
                      ),
                    },
                    {
                      value: "erase",
                      label: (
                        <>
                          <Eraser /> Erase
                        </>
                      ),
                    },
                  ]}
                />
                <div className="flex min-w-48 flex-1 items-center gap-2">
                  <span className="text-2xs text-fg-muted">Size</span>
                  <Slider
                    aria-label="Brush size"
                    min={Math.max(2, Math.round(Math.max(naturalW, naturalH) / 200))}
                    max={Math.round(Math.max(naturalW, naturalH) / 4)}
                    value={[brush]}
                    onValueChange={(v) => setBrush(v[0] ?? brush)}
                    className="flex-1"
                  />
                </div>
                <IconButton
                  label="Undo stroke"
                  size="sm"
                  disabled={strokes.length === 0}
                  onClick={() => setStrokes((s) => s.slice(0, -1))}
                >
                  <RotateCcw />
                </IconButton>
                <IconButton
                  label="Clear mask"
                  size="sm"
                  disabled={strokes.length === 0}
                  onClick={() => setStrokes([])}
                >
                  <Trash2 />
                </IconButton>
              </div>
              <Textarea
                minRows={2}
                autoResize
                aria-label="What should be there instead"
                placeholder="What should be there instead? e.g. a terracotta pot with olive branches"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <AiActionButton
            action="inpaint"
            credits={creditsFor("ai.inpaint")}
            variant="primary"
            loading={busy}
            disabled={!target || strokes.length === 0 || !prompt.trim()}
            onClick={() => void submit()}
          >
            Repaint
          </AiActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const inpaintModal: ModalDef = { id: "ai.inpaint", component: InpaintDialog };
