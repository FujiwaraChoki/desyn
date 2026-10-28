"use client";

import { ArrowUpRight } from "lucide-react";
import { useInView } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/components/site/usePrefersReducedMotion";
import { BLUEPRINTS, BUILD_ORDER } from "@/lib/demo/blueprints";
import { SIGNUP_URL } from "@/lib/site";
import { AiDock } from "./AiDock";
import { Artboard } from "./Artboard";
import { Inspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import { PROMPT_SUGGESTIONS, useDemo } from "./useDemo";

/**
 * The interactive faux-editor. Scripted (no model call) but genuinely interactive: layers can be
 * selected, dragged, hidden and nudged; typed prompts and edits drive real layer transformations.
 */
export function LiveDemo() {
  const reduced = usePrefersReducedMotion();
  const demo = useDemo(reduced);
  const { state, generate, edit } = demo;
  const [value, setValue] = useState("");
  const [zoom, setZoom] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.45, once: true });
  const touched = useRef(false);
  const autoEdited = useRef(false);

  const interact = useCallback(() => {
    touched.current = true;
  }, []);

  // Autoplay once, gently: type the first suggestion, build it, then show one edit.
  useEffect(() => {
    if (!inView || touched.current) return;
    const text = PROMPT_SUGGESTIONS[0] ?? "";
    let i = 0;
    let typer: ReturnType<typeof setInterval> | undefined;
    let launch: ReturnType<typeof setTimeout> | undefined;
    const start = setTimeout(
      () => {
        if (touched.current) return;
        if (reduced) {
          generate(text);
          return;
        }
        typer = setInterval(() => {
          if (touched.current) {
            clearInterval(typer);
            setValue("");
            return;
          }
          i += 1;
          setValue(text.slice(0, i));
          if (i >= text.length) {
            clearInterval(typer);
            launch = setTimeout(() => {
              if (touched.current) return;
              setValue("");
              generate(text);
            }, 380);
          }
        }, 34);
      },
      reduced ? 0 : 500,
    );
    return () => {
      clearTimeout(start);
      if (typer) clearInterval(typer);
      if (launch) clearTimeout(launch);
    };
  }, [inView, reduced, generate]);

  useEffect(() => {
    if (state.phase !== "ready" || touched.current || autoEdited.current || !state.design) return;
    const t = setTimeout(() => {
      if (touched.current) return;
      autoEdited.current = true;
      edit("premium");
    }, 2200);
    return () => clearTimeout(t);
  }, [state.phase, state.design, edit]);

  const placed = state.phase === "generating" ? state.placed : state.design ? [...BUILD_ORDER] : [];
  const layers = state.design ? state.design.layers.filter((l) => placed.includes(l.id)) : [];
  const docName = state.design ? BLUEPRINTS[state.design.blueprint].label : "Untitled";

  return (
    <div ref={root} className="relative">
      <div className="panel-edge overflow-hidden rounded-[22px] border border-fg/10 bg-surface-1">
        {/* top bar */}
        <div className="flex h-12 items-center gap-3 border-b border-fg/[0.07] px-4">
          <div className="hidden items-center gap-1.5 sm:flex" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-fg/15" />
            <span className="size-2.5 rounded-full bg-fg/15" />
            <span className="size-2.5 rounded-full bg-fg/15" />
          </div>
          <div className="flex min-w-0 items-center gap-2 text-[13px] sm:ml-3">
            <span className="hidden text-subtle sm:inline">Demo</span>
            <span className="hidden text-fg/25 sm:inline">/</span>
            <span className="truncate text-fg/85">{docName}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden rounded-[6px] border border-fg/10 px-2 py-1 font-mono text-[11px] text-subtle md:inline">
              {zoom ? `${Math.round(zoom * 100)}%` : "—"}
            </span>
            <a
              href={SIGNUP_URL}
              className="flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-fg/[0.08] px-3 text-[12.5px] text-fg/85 transition-colors hover:bg-fg/[0.12]"
            >
              <span className="hidden sm:inline">Open in Desyn</span>
              <span className="sm:hidden">Open</span>
              <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="grid md:grid-cols-[208px_1fr] lg:grid-cols-[216px_1fr_248px]">
          <aside
            className="hidden border-r border-fg/[0.07] py-2 md:block"
            aria-label="Layers panel"
          >
            <LayersPanel
              layers={layers}
              selected={state.selected}
              glow={state.glow}
              onSelect={(id) => {
                interact();
                demo.select(id);
              }}
              onToggle={(id) => {
                interact();
                demo.toggle(id);
              }}
            />
          </aside>

          <div className="dot-grid relative flex min-w-0 flex-col">
            <div className="h-[min(100vw,440px)] p-5 sm:h-[480px] sm:p-7 lg:h-[500px] xl:h-[540px]">
              {state.design ? (
                <Artboard
                  design={state.design}
                  placed={placed}
                  selected={state.selected}
                  glow={state.glow}
                  sweep={state.sweep}
                  generating={state.phase === "generating"}
                  reduced={reduced}
                  onSelect={(id) => {
                    if (id) interact();
                    demo.select(id);
                  }}
                  onBeginMove={demo.beginMove}
                  onMove={demo.move}
                  onScale={setZoom}
                />
              ) : (
                <EmptyArtboard onScale={setZoom} />
              )}
            </div>
            <div className="border-t border-fg/[0.07] md:hidden">
              <LayersPanel
                compact
                layers={layers}
                selected={state.selected}
                glow={state.glow}
                onSelect={(id) => {
                  interact();
                  demo.select(id);
                }}
                onToggle={demo.toggle}
              />
            </div>
            <div className="px-3 pb-3 md:px-6 md:pb-5">
              <div className="mx-auto max-w-[560px]">
                <AiDock
                  state={state}
                  value={value}
                  onChange={setValue}
                  onSubmit={demo.submit}
                  onEdit={demo.edit}
                  onUndo={demo.undo}
                  onReset={() => {
                    demo.reset();
                    setValue("");
                    inputRef.current?.focus();
                  }}
                  inputRef={inputRef}
                  onInteract={interact}
                />
              </div>
            </div>
          </div>

          <aside className="hidden border-l border-fg/[0.07] lg:block" aria-label="Inspector">
            <Inspector design={state.design} selected={state.selected} />
          </aside>
        </div>
      </div>
      <p className="mt-4 text-center text-[13px] text-subtle">
        A scripted demo running in your browser. In Desyn, an AI agent makes these edits on your
        real document.
      </p>
    </div>
  );
}

function EmptyArtboard({ onScale }: { onScale: (s: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / 1080, r.height / 1350);
      setSize({ w: 1080 * s, h: 1350 * s });
      onScale(s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onScale]);
  return (
    <div ref={box} className="grid h-full w-full place-items-center">
      {size && (
        <div
          className="grid place-items-center rounded-[3px] border border-dashed border-fg/15 bg-fg/[0.02]"
          style={{ width: size.w, height: size.h }}
        >
          <p className="px-6 text-center font-serif text-[clamp(18px,2vw,24px)] leading-tight text-subtle">
            Your design appears here,
            <br />
            layer by layer.
          </p>
        </div>
      )}
    </div>
  );
}
