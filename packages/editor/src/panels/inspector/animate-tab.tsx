"use client";

import { type Animation, type Design, type Node, newId } from "@desyn/schema";
import { Button, cn, SegmentedControl, Select } from "@desyn/ui";
import { Info, Pause, Play, Plus, Trash2, Wand } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEditor } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { useGate } from "../lib/gate.ts";
import { useLiveEdit } from "../lib/live.ts";
import { updateEach } from "../lib/ops.ts";
import { InspectorSection, MiniButton, PanelEmpty } from "../ui/primitives.tsx";
import { Num } from "./fields.tsx";
import { useInspectorTarget } from "./hooks.ts";

/**
 * Animate tab: entrance / exit / loop animations on the selected layers (presets, timing, easing) and a
 * live preview that plays the page's animations on the canvas (engine `timeMs`), for presentations and video.
 */

type Preset = Animation["preset"];
type Phase = Animation["phase"];

const PRESETS: { id: Preset; label: string; phases: Phase[] }[] = [
  { id: "fade", label: "Fade", phases: ["in", "out"] },
  { id: "rise", label: "Rise", phases: ["in", "out"] },
  { id: "drop", label: "Drop", phases: ["in", "out"] },
  { id: "slide-left", label: "Slide left", phases: ["in", "out"] },
  { id: "slide-right", label: "Slide right", phases: ["in", "out"] },
  { id: "zoom-in", label: "Zoom in", phases: ["in", "out"] },
  { id: "zoom-out", label: "Zoom out", phases: ["in", "out"] },
  { id: "pop", label: "Pop", phases: ["in", "out"] },
  { id: "rotate", label: "Spin", phases: ["in", "out", "loop"] },
  { id: "wipe", label: "Wipe", phases: ["in", "out"] },
  { id: "typewriter", label: "Typewriter", phases: ["in"] },
  { id: "blur-in", label: "Blur", phases: ["in"] },
  { id: "pulse", label: "Pulse", phases: ["loop"] },
  { id: "float", label: "Float", phases: ["loop"] },
  { id: "shake", label: "Shake", phases: ["loop"] },
];

const EASINGS: Animation["easing"][] = [
  "ease-out",
  "ease-in-out",
  "ease-in",
  "ease",
  "linear",
  "spring",
];

/** CSS keyframes approximating each preset, for the hover previews of the preset tiles. */
const TILE_MOTION: Partial<Record<Preset, string>> = {
  fade: "dsn-anim-fade",
  rise: "dsn-anim-rise",
  drop: "dsn-anim-drop",
  "slide-left": "dsn-anim-slide-left",
  "slide-right": "dsn-anim-slide-right",
  "zoom-in": "dsn-anim-zoom-in",
  "zoom-out": "dsn-anim-zoom-out",
  pop: "dsn-anim-pop",
  rotate: "dsn-anim-rotate",
  pulse: "dsn-anim-pulse",
  float: "dsn-anim-float",
  shake: "dsn-anim-shake",
  "blur-in": "dsn-anim-blur",
  wipe: "dsn-anim-wipe",
  typewriter: "dsn-anim-type",
};

const KEYFRAMES = `
@keyframes dsn-anim-fade{from{opacity:0}to{opacity:1}}
@keyframes dsn-anim-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes dsn-anim-drop{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
@keyframes dsn-anim-slide-left{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
@keyframes dsn-anim-slide-right{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:none}}
@keyframes dsn-anim-zoom-in{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:none}}
@keyframes dsn-anim-zoom-out{from{opacity:0;transform:scale(1.6)}to{opacity:1;transform:none}}
@keyframes dsn-anim-pop{0%{opacity:0;transform:scale(.4)}70%{opacity:1;transform:scale(1.12)}100%{transform:none}}
@keyframes dsn-anim-rotate{from{transform:rotate(-180deg);opacity:0}to{transform:none;opacity:1}}
@keyframes dsn-anim-pulse{0%,100%{transform:none}50%{transform:scale(1.15)}}
@keyframes dsn-anim-float{0%,100%{transform:none}50%{transform:translateY(-5px)}}
@keyframes dsn-anim-shake{0%,100%{transform:none}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
@keyframes dsn-anim-blur{from{filter:blur(6px);opacity:0}to{filter:none;opacity:1}}
@keyframes dsn-anim-wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes dsn-anim-type{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
`;

function endOf(nodes: Node[]): number {
  let end = 0;
  for (const n of nodes)
    for (const a of n.anim ?? [])
      if (a.phase !== "loop") end = Math.max(end, a.startMs + a.durationMs);
  return end;
}

export function AnimateTab(_props: SlotProps) {
  const editor = useEditor();
  const target = useInspectorTarget();
  const gate = useGate();
  const edit = useLiveEdit("Animation");
  const { ids, nodes, editable, page, design } = target;
  const [phase, setPhase] = useState<Phase>("in");
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    editor.engineClient?.setRenderOptions({ timeMs: undefined });
    setPlaying(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: stop the preview on unmount only
  useEffect(() => () => stop(), []);

  const play = () => {
    const client = editor.engineClient;
    if (!client || !design || !page) return;
    const all = Object.values(design.nodes).filter((n) => n.anim?.length);
    const duration = Math.max(endOf(all), 1200) + 400;
    const t0 = performance.now();
    setPlaying(true);
    const tick = () => {
      const t = performance.now() - t0;
      if (t > duration) {
        stop();
        return;
      }
      client.setRenderOptions({ timeMs: t });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const playButton = (
    <Button
      size="sm"
      variant={playing ? "secondary" : "primary"}
      leadingIcon={playing ? <Pause /> : <Play />}
      disabled={!editor.engineClient}
      onClick={() => (playing ? stop() : play())}
      className="w-full"
    >
      {playing ? "Stop preview" : "Preview page"}
    </Button>
  );

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-3 py-3">
        <PanelEmpty
          icon={<Wand />}
          title={
            <>
              bring it to <em className="text-accent">life</em>
            </>
          }
          description="Select layers to give them entrance, exit or looping animations."
        />
        {playButton}
      </div>
    );
  }

  const first = nodes[0] as Node;
  const list = first.anim ?? [];
  const sameList = nodes.every((n) => JSON.stringify(n.anim ?? []) === JSON.stringify(list));
  const current = list.find((a) => a.phase === phase);
  const choose = (preset: Preset) => {
    if (!gate.check("presentation")) return;
    edit.apply((d: Design) =>
      updateEach(d, ids, (n) => {
        const existing = (n.anim ?? []).filter((a) => a.phase !== phase);
        const prev = (n.anim ?? []).find((a) => a.phase === phase);
        const anim: Animation = {
          id: prev?.id ?? newId(),
          preset,
          phase,
          startMs: prev?.startMs ?? (phase === "out" ? 2000 : 0),
          durationMs: prev?.durationMs ?? (phase === "loop" ? 1600 : 600),
          easing: prev?.easing ?? (phase === "in" ? "ease-out" : "ease-in-out"),
        };
        return { anim: [...existing, anim] };
      }),
    );
  };
  const patch = (p: Partial<Animation>) => (d: Design) =>
    updateEach(d, ids, (n) => ({
      anim: (n.anim ?? []).map((a) => (a.phase === phase ? { ...a, ...p } : a)),
    }));
  const remove = () =>
    edit.apply((d) =>
      updateEach(d, ids, (n) => {
        const next = (n.anim ?? []).filter((a) => a.phase !== phase);
        return { anim: next.length > 0 ? next : undefined };
      }),
    );
  const disabled = !editable;

  return (
    <div className="flex flex-col">
      <style>{KEYFRAMES}</style>
      <InspectorSection title="Animation">
        <SegmentedControl<Phase>
          size="sm"
          fullWidth
          aria-label="Animation phase"
          value={phase}
          onValueChange={setPhase}
          options={[
            { value: "in", label: "Enter" },
            { value: "loop", label: "Loop" },
            { value: "out", label: "Exit" },
          ]}
        />
        {!sameList ? (
          <p className="text-2xs text-fg-muted">
            The selected layers have different animations; choosing one sets it on all.
          </p>
        ) : null}
        <div className="grid grid-cols-3 gap-1.5">
          {PRESETS.filter((p) => p.phases.includes(phase)).map((p) => {
            const active = sameList && current?.preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => choose(p.id)}
                className={cn(
                  "group flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] pt-3 pb-2 transition-[background-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                  active ? "bg-accent-tint" : "bg-surface-2 hover:bg-surface-3",
                )}
              >
                <span className="grid h-6 place-items-center">
                  <span
                    aria-hidden
                    className={cn(
                      "block size-4 rounded-[4px] bg-(image:--sun-gradient) motion-reduce:[animation-name:none]",
                      active
                        ? "[animation-play-state:running]"
                        : "[animation-play-state:paused] group-hover:[animation-play-state:running]",
                    )}
                    style={{
                      animationName: TILE_MOTION[p.id] ?? "dsn-anim-fade",
                      animationDuration: phase === "loop" ? "1.4s" : "1.2s",
                      animationIterationCount: "infinite",
                      animationTimingFunction: "cubic-bezier(.16,1,.3,1)",
                      // Paused tiles rest on their final frame (entrances start invisible).
                      animationDelay: phase === "loop" ? "0s" : "-1.15s",
                    }}
                  />
                </span>
                <span
                  className={cn(
                    "text-[10px]",
                    active ? "text-fg" : "text-fg-muted group-hover:text-fg-secondary",
                  )}
                >
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>
      </InspectorSection>
      {sameList && current ? (
        <InspectorSection
          title="Timing"
          actions={
            <MiniButton label="Remove animation" disabled={disabled} onClick={remove}>
              <Trash2 />
            </MiniButton>
          }
        >
          <div className="grid grid-cols-2 gap-1.5">
            <Num
              label="Start"
              aria-label="Start time"
              unit="s"
              min={0}
              max={600}
              step={0.1}
              value={current.startMs / 1000}
              disabled={disabled}
              onCommit={(v) => edit.commit(patch({ startMs: Math.round(v * 1000) }))}
            />
            <Num
              label="Dur"
              aria-label="Duration"
              unit="s"
              min={0.1}
              max={60}
              step={0.1}
              value={current.durationMs / 1000}
              disabled={disabled}
              onCommit={(v) => edit.commit(patch({ durationMs: Math.round(v * 1000) }))}
            />
          </div>
          <Select<Animation["easing"]>
            aria-label="Easing"
            size="sm"
            value={current.easing}
            disabled={disabled}
            onValueChange={(easing) => edit.apply(patch({ easing }))}
            options={EASINGS.map((e) => ({
              value: e,
              label:
                e === "spring"
                  ? "Spring"
                  : e.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
            }))}
          />
        </InspectorSection>
      ) : (
        <div className="px-3 pt-2 text-2xs text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <Plus className="size-3" /> Pick a preset to add an{" "}
            {phase === "in" ? "entrance" : phase === "out" ? "exit" : "looping"} animation.
          </span>
        </div>
      )}
      <div className="flex flex-col gap-2 px-3 py-3">
        {playButton}
        <p className="flex items-center gap-1 text-2xs text-fg-muted">
          <Info className="size-3 text-fg-muted" />
          Animations play in presentations and video exports.
        </p>
      </div>
    </div>
  );
}
