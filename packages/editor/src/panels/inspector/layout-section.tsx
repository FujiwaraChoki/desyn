"use client";

import type { AutoLayout, Design, FrameNode, Node } from "@desyn/schema";
import { cn, SegmentedControl, Select, Switch } from "@desyn/ui";
import { ArrowDown, ArrowRight, Grid3x3, Minus, Plus, Rows3, Scan } from "lucide-react";
import { useState } from "react";
import { inferAutoLayout } from "../../commands/edit.ts";
import { useGate } from "../lib/gate.ts";
import { useLiveEdit } from "../lib/live.ts";
import { common, updateEach } from "../lib/ops.ts";
import { InspectorSection, MiniButton, Row } from "../ui/primitives.tsx";
import { Num } from "./fields.tsx";
import type { InspectorTarget } from "./hooks.ts";

/**
 * Auto layout (frames): direction, gap, padding (uniform or per side), alignment grid, wrap, grid columns,
 * clip content. Children of auto-layout frames get sizing (fixed / hug / fill); children of plain frames
 * get constraints.
 */

type Sizing = "fixed" | "hug" | "fill";
type ConstraintH = NonNullable<Node["constraints"]>["h"];
type ConstraintV = NonNullable<Node["constraints"]>["v"];

const MAIN: AutoLayout["mainAlign"][] = ["start", "center", "end"];
const CROSS: AutoLayout["crossAlign"][] = ["start", "center", "end"];

export function LayoutSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable, design } = target;
  const gate = useGate();
  const edit = useLiveEdit("Auto layout");
  const frames = nodes.filter((n): n is FrameNode => n.type === "frame");
  const ids = frames.map((n) => n.id);
  const [sides, setSides] = useState(false);
  const layout =
    frames.length > 0 && frames.every((f) => f.layout)
      ? (frames[0] as FrameNode).layout
      : undefined;
  const disabled = !editable;

  const parentLayouts = design
    ? nodes.map((n) => {
        const p = n.parent ? design.nodes[n.parent] : undefined;
        return p && p.type === "frame" ? (p as FrameNode) : null;
      })
    : [];
  const inAutoLayout = nodes.length > 0 && parentLayouts.every((p) => p?.layout);
  const inPlainFrame = nodes.length > 0 && parentLayouts.every((p) => p && !p.layout);

  const setLayout = (patch: Partial<AutoLayout>) => (d: Design) =>
    updateEach(d, ids, (n) =>
      n.type === "frame" && n.layout ? { layout: { ...n.layout, ...patch } } : null,
    );

  if (frames.length === 0 && !inAutoLayout && !inPlainFrame) return null;

  return (
    <>
      {frames.length > 0 ? (
        <InspectorSection
          title="Auto layout"
          actions={
            <MiniButton
              label={layout ? "Remove auto layout" : "Add auto layout"}
              disabled={disabled}
              onClick={() => {
                if (!layout && !gate.check("layout.auto")) return;
                edit.apply((d) =>
                  updateEach(d, ids, (n) => {
                    if (n.type !== "frame") return null;
                    return layout
                      ? { layout: undefined }
                      : { layout: inferAutoLayout(d, n.children) };
                  }),
                );
              }}
            >
              {layout ? <Minus /> : <Plus />}
            </MiniButton>
          }
          empty={!layout}
        >
          {layout ? (
            <>
              <div className="flex items-center gap-1.5">
                <SegmentedControl<AutoLayout["mode"]>
                  size="sm"
                  aria-label="Direction"
                  value={layout.mode}
                  onValueChange={(mode) =>
                    edit.apply(
                      setLayout(
                        mode === "grid" ? { mode, columns: layout.columns ?? 2 } : { mode },
                      ),
                    )
                  }
                  options={[
                    { value: "row", label: <ArrowRight />, "aria-label": "Horizontal", disabled },
                    { value: "column", label: <ArrowDown />, "aria-label": "Vertical", disabled },
                    { value: "grid", label: <Grid3x3 />, "aria-label": "Grid", disabled },
                  ]}
                />
                <Num
                  label={<Rows3 className="size-3" />}
                  aria-label="Gap"
                  scrubTitle="Gap between items"
                  min={0}
                  value={layout.gap}
                  disabled={disabled}
                  onLive={(v) => edit.preview(setLayout({ gap: v }))}
                  onCommit={(v) => edit.commit(setLayout({ gap: v }))}
                />
              </div>
              {layout.mode === "grid" ? (
                <div className="grid grid-cols-2 gap-1.5">
                  <Num
                    label="Cols"
                    aria-label="Grid columns"
                    min={1}
                    max={24}
                    value={layout.columns ?? 2}
                    disabled={disabled}
                    onCommit={(v) => edit.commit(setLayout({ columns: Math.round(v) }))}
                  />
                  <Num
                    label="Row"
                    aria-label="Row gap"
                    min={0}
                    value={layout.rowGap ?? layout.gap}
                    disabled={disabled}
                    onLive={(v) => edit.preview(setLayout({ rowGap: v }))}
                    onCommit={(v) => edit.commit(setLayout({ rowGap: v }))}
                  />
                </div>
              ) : null}
              <div className="flex items-start gap-2">
                <AlignGrid
                  layout={layout}
                  disabled={disabled}
                  onChange={(main, cross) =>
                    edit.apply(setLayout({ mainAlign: main, crossAlign: cross }))
                  }
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-center gap-1">
                    {sides ? null : (
                      <Num
                        label="P"
                        aria-label="Padding"
                        scrubTitle="Padding"
                        min={0}
                        value={
                          layout.padding.every((p) => p === layout.padding[0])
                            ? layout.padding[0]
                            : null
                        }
                        disabled={disabled}
                        onLive={(v) => edit.preview(setLayout({ padding: [v, v, v, v] }))}
                        onCommit={(v) => edit.commit(setLayout({ padding: [v, v, v, v] }))}
                      />
                    )}
                    <MiniButton
                      label="Padding per side"
                      active={sides}
                      onClick={() => setSides((s) => !s)}
                    >
                      <Scan />
                    </MiniButton>
                  </div>
                  {sides ? (
                    <div className="grid grid-cols-2 gap-1">
                      {(["Top", "Right", "Bottom", "Left"] as const).map((label, i) => (
                        <Num
                          key={label}
                          label={label[0]}
                          aria-label={`${label} padding`}
                          min={0}
                          value={layout.padding[i]}
                          disabled={disabled}
                          onLive={(v) =>
                            edit.preview(
                              setLayout({
                                padding: layout.padding.map((p, k) =>
                                  k === i ? v : p,
                                ) as AutoLayout["padding"],
                              }),
                            )
                          }
                          onCommit={(v) =>
                            edit.commit(
                              setLayout({
                                padding: layout.padding.map((p, k) =>
                                  k === i ? v : p,
                                ) as AutoLayout["padding"],
                              }),
                            )
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                  <Select<AutoLayout["mainAlign"]>
                    aria-label="Distribution"
                    size="sm"
                    value={
                      layout.mainAlign === "space-between" ? "space-between" : layout.mainAlign
                    }
                    disabled={disabled}
                    onValueChange={(v) => edit.apply(setLayout({ mainAlign: v }))}
                    options={[
                      { value: "start", label: "Packed" },
                      { value: "center", label: "Centered" },
                      { value: "end", label: "Packed at end" },
                      { value: "space-between", label: "Space between" },
                    ]}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-0.5">
                {layout.mode === "row" ? (
                  <Switch
                    size="sm"
                    label="Wrap"
                    checked={!!layout.wrap}
                    disabled={disabled}
                    onCheckedChange={(v) => edit.apply(setLayout({ wrap: v || undefined }))}
                  />
                ) : null}
                <Switch
                  size="sm"
                  label="Reverse"
                  checked={!!layout.reverse}
                  disabled={disabled}
                  onCheckedChange={(v) => edit.apply(setLayout({ reverse: v || undefined }))}
                />
                <Switch
                  size="sm"
                  label="Clip content"
                  checked={frames.every((f) => f.clip)}
                  disabled={disabled}
                  onCheckedChange={(v) =>
                    edit.apply((d) => updateEach(d, ids, () => ({ clip: v })))
                  }
                />
              </div>
            </>
          ) : null}
        </InspectorSection>
      ) : null}
      {inAutoLayout ? <SizingSection nodes={nodes} editable={editable} /> : null}
      {inPlainFrame ? <ConstraintsSection nodes={nodes} editable={editable} /> : null}
    </>
  );
}

/** 3 x 3 alignment picker (main axis x cross axis), like Figma's. */
function AlignGrid({
  layout,
  disabled,
  onChange,
}: {
  layout: AutoLayout;
  disabled: boolean;
  onChange: (main: AutoLayout["mainAlign"], cross: AutoLayout["crossAlign"]) => void;
}) {
  const row = layout.mode !== "column";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form chrome to the alignment grid
    <div
      role="group"
      aria-label="Alignment"
      className="grid size-[76px] shrink-0 grid-cols-3 grid-rows-3 gap-0.5 rounded-[8px] bg-surface-2 p-1"
    >
      {[0, 1, 2].map((r) =>
        [0, 1, 2].map((c) => {
          // Rows of the picker are the vertical axis: in a row layout that is the cross axis.
          const main = MAIN[row ? c : r] as AutoLayout["mainAlign"];
          const cross = CROSS[row ? r : c] as AutoLayout["crossAlign"];
          const on = layout.mainAlign === main && layout.crossAlign === cross;
          return (
            <button
              key={`${r}-${c}`}
              type="button"
              aria-pressed={on}
              aria-label={`${["Top", "Middle", "Bottom"][r]} ${["left", "center", "right"][c]}`}
              disabled={disabled}
              onClick={() => onChange(main, cross)}
              className="group grid cursor-pointer place-items-center rounded-[4px] outline-none hover:bg-fg/6 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
            >
              <span
                className={cn(
                  "rounded-full transition-all duration-150",
                  on
                    ? "h-2.5 w-1.5 bg-accent"
                    : "size-1 bg-fg-muted/60 group-hover:bg-fg-secondary",
                )}
              />
            </button>
          );
        }),
      )}
    </div>
  );
}

function SizingSection({ nodes, editable }: { nodes: Node[]; editable: boolean }) {
  const edit = useLiveEdit("Resizing");
  const ids = nodes.map((n) => n.id);
  const h = common(nodes, (n) => n.sizing?.h ?? "fixed");
  const v = common(nodes, (n) => n.sizing?.v ?? "fixed");
  const set = (axis: "h" | "v", value: Sizing) =>
    edit.apply((d) =>
      updateEach(d, ids, (n) => {
        const next = {
          h: n.sizing?.h ?? "fixed",
          v: n.sizing?.v ?? "fixed",
          [axis]: value,
        } as NonNullable<Node["sizing"]>;
        return { sizing: next.h === "fixed" && next.v === "fixed" ? undefined : next };
      }),
    );
  const options = [
    { value: "fixed" as const, label: "Fixed" },
    { value: "hug" as const, label: "Hug" },
    { value: "fill" as const, label: "Fill" },
  ];
  return (
    <InspectorSection title="Resizing in auto layout">
      <Row label="Width">
        <Select<Sizing>
          aria-label="Horizontal resizing"
          size="sm"
          value={h ?? undefined}
          placeholder="Mixed"
          disabled={!editable}
          onValueChange={(x) => set("h", x)}
          options={options}
          className="flex-1"
        />
      </Row>
      <Row label="Height">
        <Select<Sizing>
          aria-label="Vertical resizing"
          size="sm"
          value={v ?? undefined}
          placeholder="Mixed"
          disabled={!editable}
          onValueChange={(x) => set("v", x)}
          options={options}
          className="flex-1"
        />
      </Row>
    </InspectorSection>
  );
}

function ConstraintsSection({ nodes, editable }: { nodes: Node[]; editable: boolean }) {
  const edit = useLiveEdit("Constraints");
  const ids = nodes.map((n) => n.id);
  const h = common(nodes, (n) => n.constraints?.h ?? "left");
  const v = common(nodes, (n) => n.constraints?.v ?? "top");
  const set = (axis: "h" | "v", value: string) =>
    edit.apply((d) =>
      updateEach(d, ids, (n) => {
        const next = {
          h: n.constraints?.h ?? "left",
          v: n.constraints?.v ?? "top",
          [axis]: value,
        } as NonNullable<Node["constraints"]>;
        return { constraints: next.h === "left" && next.v === "top" ? undefined : next };
      }),
    );
  return (
    <InspectorSection title="Constraints">
      <div className="flex items-center gap-2">
        <ConstraintPreview h={h ?? "left"} v={v ?? "top"} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Select<ConstraintH>
            aria-label="Horizontal constraint"
            size="sm"
            value={h ?? undefined}
            placeholder="Mixed"
            disabled={!editable}
            onValueChange={(x) => set("h", x)}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
              { value: "center", label: "Center" },
              { value: "stretch", label: "Left & right" },
              { value: "scale", label: "Scale" },
            ]}
          />
          <Select<ConstraintV>
            aria-label="Vertical constraint"
            size="sm"
            value={v ?? undefined}
            placeholder="Mixed"
            disabled={!editable}
            onValueChange={(x) => set("v", x)}
            options={[
              { value: "top", label: "Top" },
              { value: "bottom", label: "Bottom" },
              { value: "center", label: "Center" },
              { value: "stretch", label: "Top & bottom" },
              { value: "scale", label: "Scale" },
            ]}
          />
        </div>
      </div>
    </InspectorSection>
  );
}

function ConstraintPreview({ h, v }: { h: string; v: string }) {
  const on = "bg-accent";
  const off = "bg-fg-muted/30";
  return (
    <div
      aria-hidden
      className="relative size-[64px] shrink-0 rounded-[8px] border border-line-subtle bg-surface-2"
    >
      <span className="absolute inset-[22px] rounded-[3px] border border-fg-muted/60" />
      <span
        className={cn(
          "absolute top-1/2 left-1.5 h-0.5 w-3 -translate-y-1/2 rounded-full",
          h === "left" || h === "stretch" ? on : off,
        )}
      />
      <span
        className={cn(
          "absolute top-1/2 right-1.5 h-0.5 w-3 -translate-y-1/2 rounded-full",
          h === "right" || h === "stretch" ? on : off,
        )}
      />
      <span
        className={cn(
          "absolute top-1.5 left-1/2 h-3 w-0.5 -translate-x-1/2 rounded-full",
          v === "top" || v === "stretch" ? on : off,
        )}
      />
      <span
        className={cn(
          "absolute bottom-1.5 left-1/2 h-3 w-0.5 -translate-x-1/2 rounded-full",
          v === "bottom" || v === "stretch" ? on : off,
        )}
      />
      {h === "center" ? (
        <span
          className={cn(
            "absolute top-1/2 left-1/2 h-0.5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full",
            on,
          )}
        />
      ) : null}
      {v === "center" ? (
        <span
          className={cn(
            "absolute top-1/2 left-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
            on,
          )}
        />
      ) : null}
      {h === "scale" || v === "scale" ? (
        <span className="absolute inset-[18px] rounded-[4px] border border-dashed border-accent/70" />
      ) : null}
    </div>
  );
}
