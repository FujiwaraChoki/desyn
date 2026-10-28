"use client";

import { pages as listPages } from "@desyn/doc-ops";
import {
  type ChartNode,
  type Design,
  type EllipseNode,
  type Id,
  type Node,
  normalizeHex,
  type PolygonNode,
  parseLink,
  type QrNode,
  type StarNode,
  type SvgNode,
  type TableNode,
  type VideoNode,
} from "@desyn/schema";
import { Button, Input, Select, Slider, Switch } from "@desyn/ui";
import { Link as LinkIcon, Sheet, X } from "lucide-react";
import { useEditor, useEditorStore } from "../../context.tsx";
import { CHART_TYPES } from "../lib/catalog.ts";
import { useLiveEdit } from "../lib/live.ts";
import { common, round2, updateEach } from "../lib/ops.ts";
import { InspectorSection, MiniButton, Row } from "../ui/primitives.tsx";
import { ColorSwatch, Num, Percent } from "./fields.tsx";
import type { InspectorTarget } from "./hooks.ts";

/** Type-specific settings: polygons, stars, arcs, charts, tables, QR codes, SVG recolor, video, links. */

function ofType<T extends Node>(nodes: Node[], type: T["type"]): T[] {
  return nodes.filter((n): n is T => n.type === type);
}

export function ShapeSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable } = target;
  const edit = useLiveEdit("Shape");
  const polygons = ofType<PolygonNode>(nodes, "polygon");
  const stars = ofType<StarNode>(nodes, "star");
  const ellipses = ofType<EllipseNode>(nodes, "ellipse");
  if (polygons.length + stars.length + ellipses.length === 0) return null;
  const set = (ids: Id[], patch: (n: Node) => Record<string, unknown>) => (d: Design) =>
    updateEach(d, ids, patch);
  const pIds = polygons.map((n) => n.id);
  const sIds = stars.map((n) => n.id);
  const eIds = ellipses.map((n) => n.id);
  const arc = (n: EllipseNode) => n.arc ?? { start: 0, end: 360, inner: 0 };
  return (
    <InspectorSection title="Shape">
      {polygons.length > 0 ? (
        <Num
          label="Sides"
          aria-label="Polygon sides"
          min={3}
          max={60}
          step={1}
          value={common(polygons, (n) => (n as PolygonNode).sides)}
          disabled={!editable}
          onLive={(v) => edit.preview(set(pIds, () => ({ sides: Math.round(v) })))}
          onCommit={(v) => edit.commit(set(pIds, () => ({ sides: Math.round(v) })))}
        />
      ) : null}
      {stars.length > 0 ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Num
            label="Points"
            aria-label="Star points"
            min={3}
            max={60}
            step={1}
            value={common(stars, (n) => (n as StarNode).points)}
            disabled={!editable}
            onLive={(v) => edit.preview(set(sIds, () => ({ points: Math.round(v) })))}
            onCommit={(v) => edit.commit(set(sIds, () => ({ points: Math.round(v) })))}
          />
          <Percent
            label="Inner"
            aria-label="Star inner radius"
            value={common(stars, (n) => (n as StarNode).innerRatio)}
            disabled={!editable}
            onLive={(v) => edit.preview(set(sIds, () => ({ innerRatio: Math.max(0.05, v) })))}
            onCommit={(v) => edit.commit(set(sIds, () => ({ innerRatio: Math.max(0.05, v) })))}
          />
        </div>
      ) : null}
      {ellipses.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <Num
              label="Start"
              aria-label="Arc start"
              unit="°"
              min={0}
              max={360}
              value={common(ellipses, (n) => round2(arc(n as EllipseNode).start))}
              disabled={!editable}
              onLive={(v) =>
                edit.preview(set(eIds, (n) => ({ arc: { ...arc(n as EllipseNode), start: v } })))
              }
              onCommit={(v) =>
                edit.commit(set(eIds, (n) => ({ arc: { ...arc(n as EllipseNode), start: v } })))
              }
            />
            <Num
              label="Sweep"
              aria-label="Arc sweep"
              unit="°"
              min={1}
              max={360}
              value={common(ellipses, (n) =>
                round2(arc(n as EllipseNode).end - arc(n as EllipseNode).start),
              )}
              disabled={!editable}
              onLive={(v) =>
                edit.preview(
                  set(eIds, (n) => ({
                    arc: { ...arc(n as EllipseNode), end: arc(n as EllipseNode).start + v },
                  })),
                )
              }
              onCommit={(v) =>
                edit.commit(
                  set(eIds, (n) => ({
                    arc: { ...arc(n as EllipseNode), end: arc(n as EllipseNode).start + v },
                  })),
                )
              }
            />
          </div>
          <Row label="Ratio">
            <Slider
              aria-label="Donut inner ratio"
              size="sm"
              min={0}
              max={95}
              value={[
                Math.round((common(ellipses, (n) => arc(n as EllipseNode).inner) ?? 0) * 100),
              ]}
              disabled={!editable}
              showValue
              formatValue={(v) => `${v}%`}
              onValueChange={([v]) =>
                edit.preview(
                  set(eIds, (n) => ({ arc: { ...arc(n as EllipseNode), inner: (v ?? 0) / 100 } })),
                )
              }
              onValueCommit={([v]) =>
                edit.commit(
                  set(eIds, (n) => {
                    const a = { ...arc(n as EllipseNode), inner: (v ?? 0) / 100 };
                    return { arc: a.start === 0 && a.end === 360 && a.inner === 0 ? undefined : a };
                  }),
                )
              }
            />
          </Row>
        </>
      ) : null}
    </InspectorSection>
  );
}

export function ChartSection({ target }: { target: InspectorTarget }) {
  const editor = useEditor();
  const { nodes, editable } = target;
  const edit = useLiveEdit("Chart");
  const charts = ofType<ChartNode>(nodes, "chart");
  if (charts.length === 0) return null;
  const ids = charts.map((n) => n.id);
  const first = charts[0] as ChartNode;
  const setOptions = (patch: Partial<ChartNode["options"]>) => (d: Design) =>
    updateEach(d, ids, (n) =>
      n.type === "chart" ? { options: { ...(n as ChartNode).options, ...patch } } : null,
    );
  return (
    <InspectorSection title="Chart">
      <div className="flex gap-1.5">
        <Select<ChartNode["chart"]>
          aria-label="Chart type"
          size="sm"
          value={common(charts, (n) => (n as ChartNode).chart) ?? undefined}
          placeholder="Mixed"
          disabled={!editable}
          onValueChange={(v) => edit.apply((d) => updateEach(d, ids, () => ({ chart: v })))}
          options={CHART_TYPES.map((t) => ({ value: t.id, label: t.label }))}
          className="min-w-0 flex-1"
        />
        {charts.length === 1 ? (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Sheet />}
            onClick={() => editor.openModal("chart-data", { nodeId: first.id })}
          >
            Data
          </Button>
        ) : null}
      </div>
      <Row label="Colors">
        <div className="flex flex-wrap gap-1">
          {first.options.palette.slice(0, 7).map((c, i) => (
            <ColorSwatch
              // biome-ignore lint/suspicious/noArrayIndexKey: palette slots are positional
              key={`${i}-${c}`}
              label={`Chart color ${i + 1}`}
              color={c}
              showValue={false}
              showAlpha={false}
              className="w-9 flex-none px-1"
              onLive={(hex) =>
                edit.preview(
                  setOptions({
                    palette: first.options.palette.map((p, k) =>
                      k === i ? (normalizeHex(hex) ?? p) : p,
                    ),
                  }),
                )
              }
              onCommit={(hex) =>
                edit.commit(
                  setOptions({
                    palette: first.options.palette.map((p, k) =>
                      k === i ? (normalizeHex(hex) ?? p) : p,
                    ),
                  }),
                )
              }
            />
          ))}
        </div>
      </Row>
      <Row label="Text">
        <ColorSwatch
          label="Chart text color"
          color={first.options.textColor}
          showAlpha={false}
          onLive={(c) => edit.preview(setOptions({ textColor: c }))}
          onCommit={(c) => edit.commit(setOptions({ textColor: c }))}
        />
        <Num
          label="Aa"
          aria-label="Chart font size"
          min={6}
          max={96}
          value={common(charts, (n) => (n as ChartNode).options.fontSize)}
          disabled={!editable}
          className="max-w-[76px]"
          onLive={(v) => edit.preview(setOptions({ fontSize: v }))}
          onCommit={(v) => edit.commit(setOptions({ fontSize: v }))}
        />
      </Row>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <Switch
          size="sm"
          label="Legend"
          checked={first.options.legend}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(setOptions({ legend: v }))}
        />
        <Switch
          size="sm"
          label="Grid"
          checked={first.options.grid}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(setOptions({ grid: v }))}
        />
        <Switch
          size="sm"
          label="Values"
          checked={first.options.labels}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(setOptions({ labels: v }))}
        />
      </div>
    </InspectorSection>
  );
}

export function TableSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable } = target;
  const edit = useLiveEdit("Table");
  const tables = ofType<TableNode>(nodes, "table");
  if (tables.length === 0) return null;
  const ids = tables.map((n) => n.id);
  const first = tables[0] as TableNode;
  const set = (patch: (t: TableNode) => Record<string, unknown>) => (d: Design) =>
    updateEach(d, ids, (n) => (n.type === "table" ? patch(n as TableNode) : null));
  const resize = (rows: number, cols: number) =>
    set((t) => {
      const colW = t.colWidths[t.colWidths.length - 1] ?? 120;
      const rowH = t.rowHeights[t.rowHeights.length - 1] ?? 40;
      const colWidths = Array.from({ length: cols }, (_, i) => t.colWidths[i] ?? colW);
      const rowHeights = Array.from({ length: rows }, (_, i) => t.rowHeights[i] ?? rowH);
      const cells: TableNode["cells"] = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          cells.push(t.cells.find((x) => x.r === r && x.c === c) ?? { r, c, text: "" });
      return {
        rows,
        cols,
        colWidths,
        rowHeights,
        cells,
        width: colWidths.reduce((a, b) => a + b, 0),
        height: rowHeights.reduce((a, b) => a + b, 0),
      };
    });
  return (
    <InspectorSection title="Table">
      {tables.length === 1 ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Num
            label="Rows"
            aria-label="Rows"
            min={1}
            max={100}
            step={1}
            value={first.rows}
            disabled={!editable}
            onCommit={(v) => edit.commit(resize(Math.round(v), first.cols))}
          />
          <Num
            label="Cols"
            aria-label="Columns"
            min={1}
            max={30}
            step={1}
            value={first.cols}
            disabled={!editable}
            onCommit={(v) => edit.commit(resize(first.rows, Math.round(v)))}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <Switch
          size="sm"
          label="Header row"
          checked={first.header}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(set(() => ({ header: v })))}
        />
        <Switch
          size="sm"
          label="Striped"
          checked={first.stripe}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(set(() => ({ stripe: v })))}
        />
      </div>
      <Row label="Borders">
        <ColorSwatch
          label="Border color"
          color={first.borderColor}
          showAlpha={false}
          onLive={(c) => edit.preview(set(() => ({ borderColor: c })))}
          onCommit={(c) => edit.commit(set(() => ({ borderColor: c })))}
        />
        <Num
          label="W"
          aria-label="Border width"
          min={0}
          max={20}
          step={0.5}
          value={common(tables, (n) => (n as TableNode).borderWidth)}
          disabled={!editable}
          className="max-w-[72px]"
          onLive={(v) => edit.preview(set(() => ({ borderWidth: v })))}
          onCommit={(v) => edit.commit(set(() => ({ borderWidth: v })))}
        />
      </Row>
      <div className="grid grid-cols-2 gap-1.5">
        <Num
          label="Pad"
          aria-label="Cell padding"
          min={0}
          max={80}
          value={common(tables, (n) => (n as TableNode).cellPadding)}
          disabled={!editable}
          onLive={(v) => edit.preview(set(() => ({ cellPadding: v })))}
          onCommit={(v) => edit.commit(set(() => ({ cellPadding: v })))}
        />
        <Num
          label="Aa"
          aria-label="Table font size"
          min={6}
          max={200}
          value={common(tables, (n) => (n as TableNode).defaultStyle.fontSize)}
          disabled={!editable}
          onLive={(v) =>
            edit.preview(set((t) => ({ defaultStyle: { ...t.defaultStyle, fontSize: v } })))
          }
          onCommit={(v) =>
            edit.commit(set((t) => ({ defaultStyle: { ...t.defaultStyle, fontSize: v } })))
          }
        />
      </div>
    </InspectorSection>
  );
}

export function QrSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable } = target;
  const edit = useLiveEdit("QR code");
  const codes = ofType<QrNode>(nodes, "qr");
  if (codes.length === 0) return null;
  const ids = codes.map((n) => n.id);
  const first = codes[0] as QrNode;
  const set = (patch: Record<string, unknown>) => (d: Design) => updateEach(d, ids, () => patch);
  return (
    <InspectorSection title="QR code">
      {codes.length === 1 ? (
        <Input
          key={first.id}
          size="sm"
          aria-label="QR code content"
          defaultValue={first.data}
          maxLength={2000}
          disabled={!editable}
          onBlur={(e) => {
            const data = e.target.value.trim();
            if (data && data !== first.data) edit.apply(set({ data }));
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        <ColorSwatch
          label="QR color"
          color={first.fg}
          showAlpha={false}
          onLive={(c) => edit.preview(set({ fg: c }))}
          onCommit={(c) => edit.commit(set({ fg: c }))}
        />
        <ColorSwatch
          label="QR background"
          color={first.bg}
          onLive={(c) => edit.preview(set({ bg: c }))}
          onCommit={(c) => edit.commit(set({ bg: c }))}
        />
      </div>
      <div className="flex items-center gap-2">
        <Select<QrNode["errorCorrection"]>
          aria-label="Error correction"
          size="sm"
          value={common(codes, (n) => (n as QrNode).errorCorrection) ?? undefined}
          placeholder="Mixed"
          disabled={!editable}
          onValueChange={(v) => edit.apply(set({ errorCorrection: v }))}
          options={[
            { value: "L", label: "Low (7%)" },
            { value: "M", label: "Medium (15%)" },
            { value: "Q", label: "Quartile (25%)" },
            { value: "H", label: "High (30%)" },
          ]}
          className="min-w-0 flex-1"
        />
        <Switch
          size="sm"
          label="Rounded"
          checked={first.rounded}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(set({ rounded: v }))}
        />
      </div>
    </InspectorSection>
  );
}

/** Colors used in SVG markup (fill / stroke attributes and styles), for recoloring. */
export function svgColors(markup: string): string[] {
  const found = new Set<string>();
  for (const m of markup.matchAll(
    /(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8})\b/g,
  )) {
    const hex = normalizeHex(m[1] as string);
    if (hex) found.add(hex);
  }
  return [...found].slice(0, 12);
}

export function SvgSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable } = target;
  const edit = useLiveEdit("Recolor");
  const svgs = ofType<SvgNode>(nodes, "svg");
  const first = svgs[0];
  if (svgs.length !== 1 || !first?.markup) return null;
  const colors = svgColors(first.markup);
  if (colors.length === 0) return null;
  const set = (from: string, to: string) => (d: Design) =>
    updateEach(d, [first.id], (n) => {
      const recolor = { ...((n as SvgNode).recolor ?? {}) };
      if (to === from) delete recolor[from];
      else recolor[from] = to;
      return { recolor: Object.keys(recolor).length > 0 ? recolor : undefined };
    });
  return (
    <InspectorSection
      title="Graphic colors"
      actions={
        first.recolor ? (
          <MiniButton
            label="Reset colors"
            disabled={!editable}
            onClick={() =>
              edit.apply((d) => updateEach(d, [first.id], () => ({ recolor: undefined })))
            }
          >
            <X />
          </MiniButton>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-1">
        {colors.map((c) => (
          <ColorSwatch
            key={c}
            label={`Replace ${c}`}
            color={first.recolor?.[c] ?? c}
            showValue={false}
            className="w-9 flex-none px-1"
            onLive={(to) => edit.preview(set(c, to))}
            onCommit={(to) => edit.commit(set(c, to))}
          />
        ))}
      </div>
    </InspectorSection>
  );
}

export function VideoSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable } = target;
  const edit = useLiveEdit("Video");
  const videos = ofType<VideoNode>(nodes, "video");
  if (videos.length === 0) return null;
  const ids = videos.map((n) => n.id);
  const first = videos[0] as VideoNode;
  const set = (patch: Record<string, unknown>) => (d: Design) => updateEach(d, ids, () => patch);
  return (
    <InspectorSection title="Video">
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <Switch
          size="sm"
          label="Muted"
          checked={first.muted}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(set({ muted: v }))}
        />
        <Switch
          size="sm"
          label="Loop"
          checked={first.loop}
          disabled={!editable}
          onCheckedChange={(v) => edit.apply(set({ loop: v }))}
        />
      </div>
      <Row label="Volume">
        <Slider
          aria-label="Volume"
          size="sm"
          min={0}
          max={100}
          value={[Math.round(first.volume * 100)]}
          disabled={!editable || first.muted}
          showValue
          formatValue={(v) => `${v}%`}
          onValueChange={([v]) => edit.preview(set({ volume: (v ?? 0) / 100 }))}
          onValueCommit={([v]) => edit.commit(set({ volume: (v ?? 0) / 100 }))}
        />
      </Row>
      <div className="grid grid-cols-2 gap-1.5">
        <Num
          label="In"
          aria-label="Trim start"
          unit="s"
          min={0}
          step={0.1}
          value={round2(first.trimStartMs / 1000)}
          disabled={!editable}
          onCommit={(v) => edit.commit(set({ trimStartMs: Math.round(v * 1000) }))}
        />
        <Num
          label="Out"
          aria-label="Trim end"
          unit="s"
          min={0}
          step={0.1}
          value={first.trimEndMs !== undefined ? round2(first.trimEndMs / 1000) : null}
          placeholder="End"
          disabled={!editable}
          onCommit={(v) =>
            edit.commit(set({ trimEndMs: v > 0 ? Math.round(v * 1000) : undefined }))
          }
        />
      </div>
    </InspectorSection>
  );
}

/** Link on a layer: a web address or another page of this design. */
export function LinkSection({ target }: { target: InspectorTarget }) {
  const { nodes, editable } = target;
  const edit = useLiveEdit("Link");
  const design = useEditorStore((s) => s.doc.design);
  if (nodes.length === 0 || !design) return null;
  const ids = nodes.map((n) => n.id);
  const link = common(nodes, (n) => n.link ?? "");
  const parsed = link ? parseLink(link) : null;
  const pages = listPages(design);
  const set = (value: string | undefined) =>
    edit.apply((d) => updateEach(d, ids, () => ({ link: value })));
  return (
    <InspectorSection
      title="Link"
      actions={
        link ? (
          <MiniButton label="Remove link" disabled={!editable} onClick={() => set(undefined)}>
            <X />
          </MiniButton>
        ) : null
      }
    >
      <Input
        key={`${ids.join(",")}:${link ?? "mixed"}`}
        size="sm"
        aria-label="Link address"
        placeholder={link === null ? "Mixed" : "https://… or pick a page"}
        defaultValue={parsed?.kind === "url" ? parsed.href : ""}
        leading={<LinkIcon className="size-3.5" />}
        disabled={!editable}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return;
          const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
          const ok = parseLink(withScheme);
          if (ok?.kind !== "url") {
            e.target.setAttribute("aria-invalid", "true");
            return;
          }
          e.target.removeAttribute("aria-invalid");
          if (ok.href !== link) set(ok.href);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {pages.length > 1 ? (
        <Select<string>
          aria-label="Link to page"
          size="sm"
          value={parsed?.kind === "page" ? parsed.pageId : undefined}
          placeholder="Link to a page…"
          disabled={!editable}
          onValueChange={(pageId) => set(`page:${pageId}`)}
          options={pages.map((p, i) => ({
            value: p.id,
            label: `${i + 1}. ${p.name || `Page ${i + 1}`}`,
          }))}
        />
      ) : null}
    </InspectorSection>
  );
}
