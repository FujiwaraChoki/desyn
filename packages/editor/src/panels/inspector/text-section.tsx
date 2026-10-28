"use client";

import type { Design, Id, Node, ParagraphStyle, TextNode, TextStyle } from "@desyn/schema";
import { FontPickerButton, SegmentedControl, Select, Toggle } from "@desyn/ui";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowLeftRight,
  ArrowUpDown,
  Italic,
  List,
  ListOrdered,
  Maximize2,
  Strikethrough,
  Underline,
} from "lucide-react";
import { useMemo } from "react";
import { useEditorStore } from "../../context.tsx";
import { fontOptions, fontWeights, loadPreviewFont, WEIGHT_NAMES } from "../lib/fonts.ts";
import { useLiveEdit } from "../lib/live.ts";
import { common, round2, updateEach } from "../lib/ops.ts";
import { CenteredSlider, InspectorSection, Row } from "../ui/primitives.tsx";
import { Num } from "./fields.tsx";
import type { InspectorTarget } from "./hooks.ts";

/**
 * Typography for text layers: family (lazy previews), weight, italic, size, line height, letter spacing,
 * alignment, vertical alignment, lists, case, decoration, paragraph spacing, resizing and curved text.
 * Changes apply to the whole layer: matching per-run overrides are cleared so the new value shows
 * everywhere (character-level styling happens while editing text on the canvas).
 */

type StyleKey = keyof TextStyle;

function stylePatch(n: TextNode, patch: Partial<TextStyle>): Record<string, unknown> {
  const keys = Object.keys(patch) as StyleKey[];
  const runs = n.runs.map((r) => {
    if (!r.style || !keys.some((k) => k in (r.style as object))) return r;
    const style = { ...r.style };
    for (const k of keys) delete style[k];
    return Object.keys(style).length > 0 ? { ...r, style } : { text: r.text };
  });
  return { style: { ...n.style, ...patch }, runs };
}

function paragraphPatch(n: TextNode, patch: Partial<ParagraphStyle>): Record<string, unknown> {
  return { paragraph: { ...n.paragraph, ...patch } };
}

export function TextSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable } = target;
  const texts = nodes.filter((n): n is TextNode => n.type === "text");
  const ids: Id[] = texts.map((n) => n.id);
  const design = useEditorStore((s) => s.doc.design);
  const fonts = useMemo(() => fontOptions(design), [design]);
  const typo = useLiveEdit("Text style");
  const para = useLiveEdit("Paragraph");
  if (texts.length === 0) return null;

  const style = (patch: Partial<TextStyle>) => (d: Design) =>
    updateEach(d, ids, (n) => (n.type === "text" ? stylePatch(n, patch) : null));
  const paragraph = (patch: Partial<ParagraphStyle>) => (d: Design) =>
    updateEach(d, ids, (n) => (n.type === "text" ? paragraphPatch(n, patch) : null));
  const node = (patch: (n: TextNode) => Record<string, unknown>) => (d: Design) =>
    updateEach(d, ids, (n) => (n.type === "text" ? patch(n) : null));

  const family = common(texts as Node[], (n) => (n as TextNode).style.fontFamily);
  const weight = common(texts as Node[], (n) => (n as TextNode).style.fontWeight);
  const italic = texts.every((n) => n.style.fontStyle === "italic");
  const size = common(texts as Node[], (n) => round2((n as TextNode).style.fontSize));
  const lh = common(texts as Node[], (n) => (n as TextNode).paragraph.lineHeight);
  const spacing = common(texts as Node[], (n) => round2((n as TextNode).style.letterSpacing * 100));
  const align = common(texts as Node[], (n) => (n as TextNode).paragraph.align);
  const valign = common(texts as Node[], (n) => (n as TextNode).verticalAlign);
  const list = common(texts as Node[], (n) => (n as TextNode).paragraph.list);
  const textCase = common(texts as Node[], (n) => (n as TextNode).style.textCase);
  const decoration = common(texts as Node[], (n) => (n as TextNode).style.decoration);
  const paraSpacing = common(texts as Node[], (n) => round2((n as TextNode).paragraph.spacing));
  const autoResize = common(texts as Node[], (n) => (n as TextNode).autoResize);
  const curve = common(texts as Node[], (n) => (n as TextNode).curve ?? 0);
  const weights = family ? fontWeights(family) : [400, 700];
  const disabled = !editable;
  const lineHeightValue =
    lh === null || lh === undefined
      ? null
      : lh.unit === "auto"
        ? 120
        : lh.unit === "percent"
          ? round2(lh.value)
          : // Pixel line heights (imports, AI) show as a percentage of the shared font size.
            size
            ? round2((lh.value / size) * 100)
            : null;

  return (
    <InspectorSection title="Text">
      <FontPickerButton
        label="Font family"
        fonts={fonts}
        {...(family ? { value: family } : {})}
        placeholder="Mixed fonts"
        loadFont={(f) => loadPreviewFont(f.family)}
        onChange={(fam) => {
          const available = fontWeights(fam);
          typo.apply((d) =>
            updateEach(d, ids, (n) => {
              if (n.type !== "text") return null;
              // Keep the weight when the new family has it, else the nearest one it has.
              const w = available.reduce(
                (best, x) =>
                  Math.abs(x - n.style.fontWeight) < Math.abs(best - n.style.fontWeight) ? x : best,
                available[0] ?? 400,
              );
              return stylePatch(n, { fontFamily: fam, fontWeight: w });
            }),
          );
        }}
      />
      <div className="flex items-center gap-1.5">
        <Select<string>
          aria-label="Font weight"
          size="sm"
          value={weight === null || weight === undefined ? undefined : String(weight)}
          placeholder="Mixed"
          disabled={disabled}
          onValueChange={(v) => typo.apply(style({ fontWeight: Number(v) }))}
          options={[...new Set([...weights, ...(weight ? [weight] : [])])]
            .sort((a, b) => a - b)
            .map((w) => ({ value: String(w), label: WEIGHT_NAMES[w] ?? String(w) }))}
          className="min-w-0 flex-1"
        />
        <Num
          label="Aa"
          aria-label="Font size"
          scrubTitle="Font size"
          min={1}
          max={2000}
          step={1}
          value={size}
          disabled={disabled}
          className="max-w-[86px]"
          onLive={(v) => typo.preview(style({ fontSize: v }))}
          onCommit={(v) => typo.commit(style({ fontSize: v }))}
        />
        <Toggle
          aria-label="Italic"
          size="sm"
          pressed={italic}
          disabled={disabled}
          onPressedChange={(on) => typo.apply(style({ fontStyle: on ? "italic" : "normal" }))}
        >
          <Italic />
        </Toggle>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Num
          label="↕"
          aria-label="Line height"
          scrubTitle="Line height"
          unit="%"
          min={50}
          max={400}
          value={lineHeightValue}
          disabled={disabled}
          onLive={(v) => para.preview(paragraph({ lineHeight: { unit: "percent", value: v } }))}
          onCommit={(v) => para.commit(paragraph({ lineHeight: { unit: "percent", value: v } }))}
        />
        <Num
          label="↔"
          aria-label="Letter spacing"
          scrubTitle="Letter spacing"
          unit="%"
          min={-50}
          max={200}
          step={0.5}
          value={spacing}
          disabled={disabled}
          onLive={(v) => typo.preview(style({ letterSpacing: v / 100 }))}
          onCommit={(v) => typo.commit(style({ letterSpacing: v / 100 }))}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <SegmentedControl<ParagraphStyle["align"]>
          size="sm"
          aria-label="Text alignment"
          value={align ?? undefined}
          onValueChange={(v) => para.apply(paragraph({ align: v }))}
          options={[
            { value: "left", label: <AlignLeft />, "aria-label": "Align left", disabled },
            { value: "center", label: <AlignCenter />, "aria-label": "Align center", disabled },
            { value: "right", label: <AlignRight />, "aria-label": "Align right", disabled },
            { value: "justify", label: <AlignJustify />, "aria-label": "Justify", disabled },
          ]}
          className="flex-1"
          fullWidth
        />
        <SegmentedControl<TextNode["verticalAlign"]>
          size="sm"
          aria-label="Vertical alignment"
          value={valign ?? undefined}
          onValueChange={(v) => typo.apply(node(() => ({ verticalAlign: v })))}
          options={[
            { value: "top", label: <AlignVerticalJustifyStart />, "aria-label": "Top", disabled },
            {
              value: "middle",
              label: <AlignVerticalJustifyCenter />,
              "aria-label": "Middle",
              disabled,
            },
            {
              value: "bottom",
              label: <AlignVerticalJustifyEnd />,
              "aria-label": "Bottom",
              disabled,
            },
          ]}
        />
      </div>
      <div className="flex items-center gap-1">
        <Toggle
          aria-label="Bulleted list"
          size="sm"
          pressed={list === "bullet"}
          disabled={disabled}
          onPressedChange={(on) => para.apply(paragraph({ list: on ? "bullet" : "none" }))}
        >
          <List />
        </Toggle>
        <Toggle
          aria-label="Numbered list"
          size="sm"
          pressed={list === "number"}
          disabled={disabled}
          onPressedChange={(on) => para.apply(paragraph({ list: on ? "number" : "none" }))}
        >
          <ListOrdered />
        </Toggle>
        <Toggle
          aria-label="Underline"
          size="sm"
          pressed={decoration === "underline"}
          disabled={disabled}
          onPressedChange={(on) => typo.apply(style({ decoration: on ? "underline" : "none" }))}
        >
          <Underline />
        </Toggle>
        <Toggle
          aria-label="Strikethrough"
          size="sm"
          pressed={decoration === "strikethrough"}
          disabled={disabled}
          onPressedChange={(on) => typo.apply(style({ decoration: on ? "strikethrough" : "none" }))}
        >
          <Strikethrough />
        </Toggle>
        <Select<TextStyle["textCase"]>
          aria-label="Letter case"
          size="sm"
          value={textCase ?? undefined}
          placeholder="Mixed"
          disabled={disabled}
          onValueChange={(v) => typo.apply(style({ textCase: v }))}
          options={[
            { value: "none", label: "Aa  As typed" },
            { value: "upper", label: "AA  Uppercase" },
            { value: "lower", label: "aa  Lowercase" },
            { value: "title", label: "Aa  Title Case" },
          ]}
          className="min-w-0 flex-1"
        />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Num
          label="¶"
          aria-label="Paragraph spacing"
          scrubTitle="Space after paragraphs"
          min={0}
          value={paraSpacing}
          disabled={disabled}
          onLive={(v) => para.preview(paragraph({ spacing: v }))}
          onCommit={(v) => para.commit(paragraph({ spacing: v }))}
        />
        <SegmentedControl<TextNode["autoResize"]>
          size="sm"
          aria-label="Resizing"
          value={autoResize ?? undefined}
          onValueChange={(v) => typo.apply(node(() => ({ autoResize: v })))}
          options={[
            { value: "width", label: <ArrowLeftRight />, "aria-label": "Auto width", disabled },
            { value: "height", label: <ArrowUpDown />, "aria-label": "Auto height", disabled },
            { value: "none", label: <Maximize2 />, "aria-label": "Fixed size", disabled },
          ]}
          fullWidth
        />
      </div>
      <Row label="Curve">
        <CenteredSlider
          aria-label="Text curve"
          size="sm"
          min={-360}
          max={360}
          step={5}
          value={[curve ?? 0]}
          disabled={disabled}
          showValue
          formatValue={(v) => `${v}°`}
          onValueChange={([v]) => typo.preview(node(() => ({ curve: v || undefined })))}
          onValueCommit={([v]) => typo.commit(node(() => ({ curve: v || undefined })))}
        />
      </Row>
    </InspectorSection>
  );
}
