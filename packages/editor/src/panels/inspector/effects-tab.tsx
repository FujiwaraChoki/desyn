"use client";

import { deepEqual } from "@desyn/doc-ops";
import type { Design, Effect } from "@desyn/schema";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  ProBadge,
  Switch,
} from "@desyn/ui";
import { Blend, Eye, EyeOff, Minus, Plus } from "lucide-react";
import { useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { useGate } from "../lib/gate.ts";
import { useLiveEdit } from "../lib/live.ts";
import { updateEach } from "../lib/ops.ts";
import { InspectorSection, MiniButton, PanelEmpty } from "../ui/primitives.tsx";
import { ColorSwatch, Num, Percent } from "./fields.tsx";
import { useInspectorTarget } from "./hooks.ts";

/** Effects tab: shadows, blurs, noise and glow on the selected layers (one list for all of them). */

type EffectType = Effect["type"];

const LABELS: Record<EffectType, string> = {
  dropShadow: "Drop shadow",
  innerShadow: "Inner shadow",
  layerBlur: "Layer blur",
  backgroundBlur: "Background blur",
  noise: "Noise",
  glow: "Glow",
};

const ADVANCED = new Set<EffectType>(["innerShadow", "backgroundBlur", "noise", "glow"]);

function make(type: EffectType): Effect {
  switch (type) {
    case "dropShadow":
      return { type, x: 0, y: 8, blur: 24, spread: 0, color: "#00000040" };
    case "innerShadow":
      return { type, x: 0, y: 2, blur: 8, spread: 0, color: "#00000033" };
    case "layerBlur":
      return { type, radius: 8 };
    case "backgroundBlur":
      return { type, radius: 20 };
    case "noise":
      return { type, amount: 0.15, scale: 1, mono: true };
    case "glow":
      return { type, radius: 24, strength: 0.8, color: "#ffb02e" };
  }
}

const PRESETS: { label: string; effects: Effect[] }[] = [
  {
    label: "Soft",
    effects: [{ type: "dropShadow", x: 0, y: 10, blur: 30, spread: -6, color: "#0000002e" }],
  },
  {
    label: "Lift",
    effects: [
      { type: "dropShadow", x: 0, y: 2, blur: 4, spread: 0, color: "#0000001f" },
      { type: "dropShadow", x: 0, y: 18, blur: 40, spread: -8, color: "#00000040" },
    ],
  },
  {
    label: "Hard",
    effects: [{ type: "dropShadow", x: 8, y: 8, blur: 0, spread: 0, color: "#000000e6" }],
  },
  { label: "Glow", effects: [{ type: "glow", radius: 28, strength: 0.85, color: "#ffb02e" }] },
];

export function EffectsTab(_props: SlotProps) {
  const target = useInspectorTarget();
  const gate = useGate();
  const edit = useLiveEdit("Effects");
  const { ids, nodes, editable } = target;
  const canEdit = useEditorStore((s) => s.mode === "edit");
  if (nodes.length === 0) {
    return (
      <PanelEmpty
        icon={<Blend />}
        title={
          <>
            select to add <em className="text-accent">depth</em>
          </>
        }
        description="Shadows, blur, noise and glow apply to the selected layers."
      />
    );
  }
  const first = nodes[0]?.effects ?? [];
  const mixed = nodes.some((n) => !deepEqual(n.effects, first));
  const setAll = (fx: Effect[]) => (d: Design) => updateEach(d, ids, () => ({ effects: fx }));
  const patchAt = (i: number, patch: Partial<Effect>) => (d: Design) =>
    updateEach(d, ids, (n) => ({
      effects: n.effects.map((e, k) => (k === i ? ({ ...e, ...patch } as Effect) : e)),
    }));
  const add = (type: EffectType) => {
    if (ADVANCED.has(type) && !gate.check("effects.advanced")) return;
    edit.apply((d) =>
      updateEach(d, ids, (n) => ({ effects: [...(mixed ? [] : n.effects), make(type)] })),
    );
  };
  const disabled = !editable || !canEdit;

  return (
    <div className="flex flex-col">
      <InspectorSection title="Presets">
        <div className="grid grid-cols-4 gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (p.effects.some((e) => ADVANCED.has(e.type)) && !gate.check("effects.advanced"))
                  return;
                edit.apply(setAll(p.effects));
              }}
              className="group flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] bg-surface-2 px-1.5 pt-1.5 pb-2 transition-colors hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {/* A paper backdrop so black shadows read in the dark theme too. */}
              <span
                aria-hidden
                className="grid h-10 w-full max-w-12 place-items-center rounded-[7px] bg-[#ece6db]"
              >
                <span
                  className="size-5 rounded-[5px] bg-white"
                  style={{
                    boxShadow:
                      p.label === "Soft"
                        ? "0 6px 14px -4px rgb(0 0 0 / .45)"
                        : p.label === "Lift"
                          ? "0 1px 2px rgb(0 0 0 / .3), 0 10px 18px -6px rgb(0 0 0 / .5)"
                          : p.label === "Hard"
                            ? "4px 4px 0 rgb(0 0 0 / .85)"
                            : "0 0 14px 3px #ffb02e",
                  }}
                />
              </span>
              <span className="text-[10px] text-fg-muted group-hover:text-fg-secondary">
                {p.label}
              </span>
            </button>
          ))}
        </div>
      </InspectorSection>
      <InspectorSection
        title="Effects"
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Add effect" size="xs" variant="ghost" disabled={disabled}>
                <Plus />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {(Object.keys(LABELS) as EffectType[]).map((t) => (
                <DropdownMenuItem key={t} onSelect={() => add(t)}>
                  <span className="flex-1">{LABELS[t]}</span>
                  {ADVANCED.has(t) && gate.locked("effects.advanced") ? (
                    <ProBadge className="ml-2 scale-90" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
        empty={!mixed && first.length === 0}
      >
        {mixed ? (
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span>Layers have different effects</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => edit.apply(setAll([]))}
              className="cursor-pointer rounded-[6px] px-2 py-1 text-fg-secondary hover:bg-fg/6 hover:text-fg"
            >
              Clear all
            </button>
          </div>
        ) : (
          first.map((fx, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: effects have no identity; the list order is the identity
              key={i}
              className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2/60 p-2"
            >
              <div className="flex items-center gap-1">
                <span className="flex-1 text-xs text-fg">{LABELS[fx.type]}</span>
                <MiniButton
                  label={fx.visible === false ? "Show effect" : "Hide effect"}
                  disabled={disabled}
                  onClick={() => edit.apply(patchAt(i, { visible: fx.visible === false }))}
                >
                  {fx.visible === false ? <EyeOff /> : <Eye />}
                </MiniButton>
                <MiniButton
                  label="Remove effect"
                  disabled={disabled}
                  onClick={() =>
                    edit.apply((d) =>
                      updateEach(d, ids, (n) => ({ effects: n.effects.filter((_, k) => k !== i) })),
                    )
                  }
                >
                  <Minus />
                </MiniButton>
              </div>
              <EffectFields
                fx={fx}
                disabled={disabled}
                onLive={(p) => edit.preview(patchAt(i, p))}
                onCommit={(p) => edit.commit(patchAt(i, p))}
              />
            </div>
          ))
        )}
      </InspectorSection>
    </div>
  );
}

function EffectFields({
  fx,
  disabled,
  onLive,
  onCommit,
}: {
  fx: Effect;
  disabled: boolean;
  onLive: (p: Partial<Effect>) => void;
  onCommit: (p: Partial<Effect>) => void;
}) {
  switch (fx.type) {
    case "dropShadow":
    case "innerShadow":
      return (
        <>
          <ColorSwatch
            label="Shadow color"
            color={fx.color}
            onLive={(color) => onLive({ color })}
            onCommit={(color) => onCommit({ color })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Num
              label="X"
              aria-label="Shadow X offset"
              value={fx.x}
              disabled={disabled}
              onLive={(x) => onLive({ x })}
              onCommit={(x) => onCommit({ x })}
            />
            <Num
              label="Y"
              aria-label="Shadow Y offset"
              value={fx.y}
              disabled={disabled}
              onLive={(y) => onLive({ y })}
              onCommit={(y) => onCommit({ y })}
            />
            <Num
              label="Blur"
              aria-label="Shadow blur"
              min={0}
              value={fx.blur}
              disabled={disabled}
              onLive={(blur) => onLive({ blur })}
              onCommit={(blur) => onCommit({ blur })}
            />
            <Num
              label="Spread"
              aria-label="Shadow spread"
              value={fx.spread}
              disabled={disabled}
              onLive={(spread) => onLive({ spread })}
              onCommit={(spread) => onCommit({ spread })}
            />
          </div>
        </>
      );
    case "layerBlur":
    case "backgroundBlur":
      return (
        <Num
          label="Radius"
          aria-label="Blur radius"
          min={0}
          max={250}
          value={fx.radius}
          disabled={disabled}
          onLive={(radius) => onLive({ radius })}
          onCommit={(radius) => onCommit({ radius })}
        />
      );
    case "noise":
      return (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <Percent
              label="Amt"
              aria-label="Noise amount"
              value={fx.amount}
              disabled={disabled}
              onLive={(amount) => onLive({ amount })}
              onCommit={(amount) => onCommit({ amount })}
            />
            <Num
              label="Size"
              aria-label="Noise scale"
              min={0.1}
              max={20}
              step={0.1}
              value={fx.scale}
              disabled={disabled}
              onLive={(scale) => onLive({ scale })}
              onCommit={(scale) => onCommit({ scale })}
            />
          </div>
          <Switch
            size="sm"
            label="Monochrome"
            checked={fx.mono}
            disabled={disabled}
            onCheckedChange={(mono) => onCommit({ mono })}
          />
        </>
      );
    case "glow":
      return (
        <>
          <ColorSwatch
            label="Glow color"
            color={fx.color}
            onLive={(color) => onLive({ color })}
            onCommit={(color) => onCommit({ color })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Num
              label="Size"
              aria-label="Glow radius"
              min={0}
              max={250}
              value={fx.radius}
              disabled={disabled}
              onLive={(radius) => onLive({ radius })}
              onCommit={(radius) => onCommit({ radius })}
            />
            <Percent
              label="Str"
              aria-label="Glow strength"
              value={fx.strength}
              disabled={disabled}
              onLive={(strength) => onLive({ strength })}
              onCommit={(strength) => onCommit({ strength })}
            />
          </div>
        </>
      );
  }
}
