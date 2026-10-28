"use client";

import { deepEqual } from "@desyn/doc-ops";
import {
  CAPS,
  type Cap,
  type Design,
  defaultStroke,
  type Fill,
  type Id,
  isShapedType,
  type Node,
  type Stroke,
  type TextNode,
} from "@desyn/schema";
import { Select } from "@desyn/ui";
import { Minus, Plus } from "lucide-react";
import { useEditor } from "../../context.tsx";
import { assetOps } from "../lib/insert.ts";
import { useLiveEdit } from "../lib/live.ts";
import { updateEach } from "../lib/ops.ts";
import { fillSwatch } from "../lib/paint.ts";
import { InspectorSection, MiniButton } from "../ui/primitives.tsx";
import { ColorSwatch, Num } from "./fields.tsx";
import { FillList } from "./fill-list.tsx";
import type { InspectorTarget } from "./hooks.ts";

/** Fill and stroke sections (shapes, frames, text color, images' borders, lines). */

function fillsOf(n: Node): Fill[] | null {
  if (n.type === "text") return n.style.fills;
  if (isShapedType(n.type)) return (n as Node & { fills: Fill[] }).fills;
  return null;
}

function setFillsPatch(n: Node, fills: Fill[]): Record<string, unknown> | null {
  if (n.type === "text") {
    // Per-run colors would hide the new color; the whole text takes it.
    const runs = n.runs.map((r) => {
      if (!r.style?.fills) return r;
      const { fills: _f, ...style } = r.style;
      return Object.keys(style).length > 0 ? { ...r, style } : { text: r.text };
    });
    return { style: { ...n.style, fills }, runs };
  }
  if (isShapedType(n.type)) return { fills };
  return null;
}

export function FillSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable, design } = target;
  const edit = useLiveEdit("Fill");
  const fillNodes = nodes.filter((n) => fillsOf(n) !== null);
  if (fillNodes.length === 0) return null;
  const ids: Id[] = fillNodes.map((n) => n.id);
  const first = fillsOf(fillNodes[0] as Node) ?? [];
  const mixed = fillNodes.some((n) => !deepEqual(fillsOf(n), first));
  const allText = fillNodes.every((n) => n.type === "text");
  const build = (fills: Fill[]) => (d: Design) =>
    updateEach(d, ids, (n) => setFillsPatch(n, fills));
  return (
    <InspectorSection
      title={allText ? "Text color" : "Fill"}
      empty={!editable && first.length === 0}
    >
      <FillList
        label={allText ? "Color" : "Fill"}
        fills={first}
        mixed={mixed}
        allowImage={!allText}
        defaultColor={
          allText
            ? "#171717"
            : first.length > 0 && design
              ? fillSwatch(design, first[first.length - 1] as Fill)
              : "#d9d9d9"
        }
        onPreview={(fills) => edit.preview(build(fills))}
        onCommit={(fills, assets) =>
          edit.commit((d) => [...(assets?.length ? assetOps(d, assets) : []), ...build(fills)(d)])
        }
      />
    </InspectorSection>
  );
}

const STROKE_TYPES = new Set([
  "rect",
  "ellipse",
  "polygon",
  "star",
  "path",
  "frame",
  "boolean",
  "line",
  "text",
  "image",
  "svg",
]);

type StrokeStyle = "solid" | "dashed" | "dotted";

function styleOf(s: Stroke): StrokeStyle {
  if (!s.dash || s.dash.length === 0) return "solid";
  return (s.dash[0] ?? 0) <= s.width * 1.01 ? "dotted" : "dashed";
}

function dashFor(style: StrokeStyle, width: number): number[] | undefined {
  if (style === "solid") return undefined;
  return style === "dotted" ? [Math.max(width, 1), Math.max(width, 1) * 2] : [width * 4, width * 3];
}

function strokesOf(n: Node): Stroke[] {
  return ((n as Node & { strokes?: Stroke[] }).strokes ?? []) as Stroke[];
}

export function StrokeSection({ target }: { target: InspectorTarget }) {
  const editor = useEditor();
  const { nodes, editable } = target;
  const edit = useLiveEdit("Stroke");
  const strokeNodes = nodes.filter((n) => STROKE_TYPES.has(n.type));
  if (strokeNodes.length === 0) return null;
  const ids = strokeNodes.map((n) => n.id);
  const first = strokesOf(strokeNodes[0] as Node);
  const mixed = strokeNodes.some((n) => !deepEqual(strokesOf(n), first));
  const lines = strokeNodes.filter((n) => n.type === "line");
  const setStrokes = (fn: (s: Stroke[], n: Node) => Stroke[]) => (d: Design) =>
    updateEach(d, ids, (n) => ({ strokes: fn(strokesOf(n), n) }));
  const patchStroke = (i: number, patch: (s: Stroke) => Stroke) =>
    setStrokes((list) => list.map((s, k) => (k === i ? patch(s) : s)));
  const color = (s: Stroke) => {
    const f = s.fills[0];
    return f && editor.design ? fillSwatch(editor.design, f) : "#171717";
  };
  return (
    <InspectorSection
      title="Stroke"
      actions={
        editable && !mixed && first.length < 4 ? (
          <MiniButton
            label="Add stroke"
            onClick={() =>
              edit.apply(
                setStrokes((list, n) => [
                  ...list,
                  defaultStroke({
                    width: n.type === "line" ? 2 : 1,
                    align: n.type === "text" ? "outside" : "inside",
                  }),
                ]),
              )
            }
          >
            <Plus />
          </MiniButton>
        ) : null
      }
      empty={!mixed && first.length === 0 && lines.length === 0}
    >
      {mixed ? (
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span>Mixed strokes</span>
          <button
            type="button"
            disabled={!editable}
            onClick={() => edit.apply(setStrokes(() => (first.length ? first : [defaultStroke()])))}
            className="cursor-pointer rounded-[6px] px-2 py-1 text-fg-secondary hover:bg-fg/6 hover:text-fg"
          >
            Use one stroke
          </button>
        </div>
      ) : (
        first.map((s, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: strokes have no identity; the list order is the identity
            key={i}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-1">
              <ColorSwatch
                label={`Stroke ${i + 1} color`}
                color={color(s)}
                onLive={(c) =>
                  edit.preview(
                    patchStroke(i, (st) => ({ ...st, fills: [{ type: "solid", color: c }] })),
                  )
                }
                onCommit={(c) =>
                  edit.commit(
                    patchStroke(i, (st) => ({ ...st, fills: [{ type: "solid", color: c }] })),
                  )
                }
              />
              <Num
                label="W"
                aria-label="Stroke width"
                min={0}
                step={0.5}
                value={s.width}
                disabled={!editable}
                className="max-w-[76px]"
                onLive={(v) =>
                  edit.preview(
                    patchStroke(i, (st) => ({
                      ...st,
                      width: v,
                      ...(st.dash ? { dash: dashFor(styleOf(st), v) } : {}),
                    })),
                  )
                }
                onCommit={(v) =>
                  edit.commit(
                    patchStroke(i, (st) => ({
                      ...st,
                      width: v,
                      ...(st.dash ? { dash: dashFor(styleOf(st), v) } : {}),
                    })),
                  )
                }
              />
              <MiniButton
                label="Remove stroke"
                disabled={!editable}
                onClick={() => edit.apply(setStrokes((list) => list.filter((_, k) => k !== i)))}
              >
                <Minus />
              </MiniButton>
            </div>
            <div className="flex items-center gap-1">
              <Select<StrokeStyle>
                aria-label="Stroke style"
                size="sm"
                value={styleOf(s)}
                disabled={!editable}
                onValueChange={(style) =>
                  edit.apply(
                    patchStroke(i, (st) => {
                      const dash = dashFor(style, st.width);
                      const { dash: _d, ...rest } = st;
                      return dash
                        ? { ...rest, dash, cap: style === "dotted" ? "round" : st.cap }
                        : rest;
                    }),
                  )
                }
                options={[
                  { value: "solid", label: "Solid" },
                  { value: "dashed", label: "Dashed" },
                  { value: "dotted", label: "Dotted" },
                ]}
                className="min-w-0 flex-1"
              />
              {lines.length === 0 ? (
                <Select<Stroke["align"]>
                  aria-label="Stroke position"
                  size="sm"
                  value={s.align}
                  disabled={!editable}
                  onValueChange={(align) => edit.apply(patchStroke(i, (st) => ({ ...st, align })))}
                  options={[
                    { value: "inside", label: "Inside" },
                    { value: "center", label: "Center" },
                    { value: "outside", label: "Outside" },
                  ]}
                  className="min-w-0 flex-1"
                />
              ) : (
                <Select<Stroke["cap"]>
                  aria-label="Line ends"
                  size="sm"
                  value={s.cap}
                  disabled={!editable}
                  onValueChange={(cap) => edit.apply(patchStroke(i, (st) => ({ ...st, cap })))}
                  options={[
                    { value: "butt", label: "Flat ends" },
                    { value: "round", label: "Round ends" },
                    { value: "square", label: "Square ends" },
                  ]}
                  className="min-w-0 flex-1"
                />
              )}
            </div>
          </div>
        ))
      )}
      {lines.length > 0 ? <LineCaps nodes={lines} editable={editable} /> : null}
    </InspectorSection>
  );
}

const CAP_LABELS: Record<Cap, string> = {
  none: "None",
  arrow: "Arrow",
  triangle: "Triangle",
  circle: "Circle",
  square: "Square",
  diamond: "Diamond",
  bar: "Bar",
};

function LineCaps({ nodes, editable }: { nodes: Node[]; editable: boolean }) {
  const edit = useLiveEdit("Line ends");
  const ids = nodes.map((n) => n.id);
  const start = nodes.every(
    (n) =>
      (n as Node & { startCap: Cap }).startCap === (nodes[0] as Node & { startCap: Cap }).startCap,
  )
    ? (nodes[0] as Node & { startCap: Cap }).startCap
    : undefined;
  const end = nodes.every(
    (n) => (n as Node & { endCap: Cap }).endCap === (nodes[0] as Node & { endCap: Cap }).endCap,
  )
    ? (nodes[0] as Node & { endCap: Cap }).endCap
    : undefined;
  return (
    <div className="grid grid-cols-2 gap-1">
      <Select<Cap>
        aria-label="Line start"
        size="sm"
        value={start}
        placeholder="Mixed"
        disabled={!editable}
        onValueChange={(v) => edit.apply((d) => updateEach(d, ids, () => ({ startCap: v })))}
        options={CAPS.map((c) => ({
          value: c,
          label: `Start: ${CAP_LABELS[c]}`,
          textValue: CAP_LABELS[c],
        }))}
      />
      <Select<Cap>
        aria-label="Line end"
        size="sm"
        value={end}
        placeholder="Mixed"
        disabled={!editable}
        onValueChange={(v) => edit.apply((d) => updateEach(d, ids, () => ({ endCap: v })))}
        options={CAPS.map((c) => ({
          value: c,
          label: `End: ${CAP_LABELS[c]}`,
          textValue: CAP_LABELS[c],
        }))}
      />
    </div>
  );
}

/** Text-only helper: whether every node is text (for section ordering). */
export function allText(nodes: Node[]): nodes is TextNode[] {
  return nodes.length > 0 && nodes.every((n) => n.type === "text");
}
