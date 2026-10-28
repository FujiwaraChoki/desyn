"use client";

import type { ChartNode } from "@desyn/schema";
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
  Input,
  PaintSwatchButton,
  Select,
  Switch,
} from "@desyn/ui";
import { Plus, Trash2 } from "lucide-react";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { CHART_TYPES } from "../lib/catalog.ts";
import { updateEach } from "../lib/ops.ts";
import {
  chartToGrid,
  type Grid,
  gridToChart,
  parseClipboard,
  pasteInto,
} from "../lib/table-data.ts";

/**
 * The chart data sheet: labels down the first column, one column per series, editable like a spreadsheet
 * (Tab / Enter move, paste a block from Sheets / Excel / CSV). Edits show on the canvas as you type and merge
 * into one undo step per editing session.
 */

const COMMIT_MS = 350;

/** Drops keys set to undefined (an optional option being cleared). */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function ChartDataDialog({
  editor,
  props,
  close,
}: SlotProps & { props: Record<string, unknown>; close: () => void }) {
  const nodeId = typeof props.nodeId === "string" ? props.nodeId : null;
  const node = useEditorStore((s) => {
    const n = nodeId ? s.doc.design?.nodes[nodeId] : undefined;
    return n?.type === "chart" ? n : null;
  });
  const [grid, setGrid] = useState<Grid>(() => (node ? chartToGrid(node.data) : [[""]]));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Grid | null>(null);
  const session = useRef(`chart:${nodeId}:${Date.now()}`);
  const canEdit = editor.canEdit;

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const g = pending.current;
    pending.current = null;
    if (!g || !nodeId) return;
    void editor.apply(
      (d) =>
        updateEach(d, [nodeId], (n) =>
          n.type === "chart" ? { data: gridToChart(g, (n as ChartNode).data) } : null,
        ),
      { label: "Edit chart data", coalesceKey: session.current },
    );
  };

  const update = (next: Grid) => {
    setGrid(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, COMMIT_MS);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: flush on unmount only
  useEffect(() => () => flush(), []);

  if (!node || !nodeId) {
    return (
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>chart not found</DialogTitle>
            <DialogDescription>
              The chart was removed. Select another chart to edit its data.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const setCell = (r: number, c: number, v: string) => {
    const next = grid.map((row) => [...row]);
    (next[r] as string[])[c] = v;
    update(next);
  };
  const addRow = () => update([...grid, Array.from({ length: grid[0]?.length ?? 2 }, () => "")]);
  const addSeries = () =>
    update(grid.map((row, i) => [...row, i === 0 ? `Series ${row.length}` : ""]));
  const removeRow = (r: number) => grid.length > 2 && update(grid.filter((_, i) => i !== r));
  const removeSeries = (c: number) =>
    (grid[0]?.length ?? 0) > 2 && update(grid.map((row) => row.filter((_, i) => i !== c)));
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n") && !text.includes(",")) return;
    e.preventDefault();
    update(pasteInto(grid, r, c, parseClipboard(text)));
  };
  const setOption = (patch: Partial<ChartNode["options"]> | { chart: ChartNode["chart"] }) =>
    void editor.apply(
      (d) =>
        updateEach(d, [nodeId], (n) =>
          n.type === "chart"
            ? "chart" in patch
              ? { chart: patch.chart }
              : { options: withoutUndefined({ ...(n as ChartNode).options, ...patch }) }
            : null,
        ),
      { label: "Chart options" },
    );
  const setSeriesColor = (c: number, color: string) =>
    void editor.apply(
      (d) =>
        updateEach(d, [nodeId], (n) => {
          if (n.type !== "chart") return null;
          const data = (n as ChartNode).data;
          return {
            data: {
              ...data,
              series: data.series.map((s, i) => (i === c - 1 ? { ...s, color } : s)),
            },
          };
        }),
      { label: "Series color", coalesceKey: `${session.current}:color` },
    );

  const focusCell = (r: number, c: number) =>
    (document.querySelector(`[data-cell="${r}:${c}"]`) as HTMLInputElement | null)?.focus();
  const cols = grid[0]?.length ?? 1;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return;
        flush();
        close();
      }}
    >
      <DialogContent size="lg" className="flex max-h-[min(760px,90dvh)] flex-col">
        <DialogHeader>
          <DialogTitle>
            chart <em className="text-accent">data</em>
          </DialogTitle>
          <DialogDescription>
            Type values or paste a range from a spreadsheet. The chart updates as you go.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <div className="flex flex-wrap items-center gap-3">
            <Select<ChartNode["chart"]>
              aria-label="Chart type"
              size="sm"
              value={node.chart}
              onValueChange={(chart) => setOption({ chart })}
              options={CHART_TYPES.map((t) => ({ value: t.id, label: t.label }))}
              className="w-36"
              disabled={!canEdit}
            />
            <Switch
              label="Legend"
              checked={node.options.legend}
              onCheckedChange={(v) => setOption({ legend: v })}
              disabled={!canEdit}
            />
            <Switch
              label="Grid"
              checked={node.options.grid}
              onCheckedChange={(v) => setOption({ grid: v })}
              disabled={!canEdit}
            />
            <Switch
              label="Values"
              checked={node.options.labels}
              onCheckedChange={(v) => setOption({ labels: v })}
              disabled={!canEdit}
            />
            <Input
              size="sm"
              aria-label="Unit"
              placeholder="Unit (%, $, k)"
              defaultValue={node.options.unit ?? ""}
              maxLength={8}
              onBlur={(e) => {
                const unit = e.target.value.trim();
                setOption(unit ? { unit } : { unit: undefined });
              }}
              className="w-32"
              disabled={!canEdit}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-[10px] border border-line-subtle">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-[1] bg-surface-2">
                <tr>
                  {grid[0]?.map((name, c) => (
                    <th
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional (series order)
                      key={`h${c}`}
                      className="min-w-28 border-b border-line-subtle p-1 text-left font-normal"
                    >
                      {c === 0 ? (
                        <span className="px-2 text-2xs text-fg-muted">Label</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <PaintSwatchButton
                            label={`Color of ${name || `series ${c}`}`}
                            showValue={false}
                            types={["solid"]}
                            side="bottom"
                            value={{
                              type: "solid",
                              color:
                                node.data.series[c - 1]?.color ??
                                node.options.palette[
                                  (c - 1) % Math.max(1, node.options.palette.length)
                                ] ??
                                "#ffb02e",
                            }}
                            onChange={() => {}}
                            onChangeEnd={(p) =>
                              p.type === "solid" && setSeriesColor(c, p.color.slice(0, 7))
                            }
                            className="w-8 shrink-0 px-1"
                          />
                          <input
                            data-cell={`0:${c}`}
                            value={name}
                            aria-label={`Series ${c} name`}
                            disabled={!canEdit}
                            onChange={(e) => setCell(0, c, e.target.value)}
                            onPaste={(e) => onPaste(e, 0, c)}
                            className="h-7 min-w-0 flex-1 rounded-[5px] bg-transparent px-2 font-medium text-fg outline-none focus:bg-surface-1 focus:ring-2 focus:ring-ring"
                          />
                          {cols > 2 ? (
                            <IconButton
                              label={`Remove ${name || `series ${c}`}`}
                              size="xs"
                              variant="ghost"
                              disabled={!canEdit}
                              onClick={() => removeSeries(c)}
                            >
                              <Trash2 />
                            </IconButton>
                          ) : null}
                        </div>
                      )}
                    </th>
                  ))}
                  <th className="w-10 border-b border-line-subtle p-1">
                    <IconButton
                      label="Add series"
                      size="xs"
                      variant="ghost"
                      disabled={!canEdit}
                      onClick={addSeries}
                    >
                      <Plus />
                    </IconButton>
                  </th>
                </tr>
              </thead>
              <tbody>
                {grid.slice(1).map((row, i) => {
                  const r = i + 1;
                  return (
                    <tr key={`r${r}`} className="group">
                      {row.map((cell, c) => (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                          key={`c${r}-${c}`}
                          className="border-b border-line-subtle/60 p-0.5"
                        >
                          <input
                            data-cell={`${r}:${c}`}
                            value={cell}
                            inputMode={c === 0 ? "text" : "decimal"}
                            aria-label={
                              c === 0
                                ? `Label ${r}`
                                : `${grid[0]?.[c] || `Series ${c}`}, ${row[0] || `row ${r}`}`
                            }
                            disabled={!canEdit}
                            onChange={(e) => setCell(r, c, e.target.value)}
                            onPaste={(e) => onPaste(e, r, c)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                if (r === grid.length - 1) addRow();
                                requestAnimationFrame(() => focusCell(r + 1, c));
                              }
                            }}
                            className={
                              c === 0
                                ? "h-8 w-full rounded-[5px] bg-transparent px-2 text-fg outline-none focus:bg-surface-1 focus:ring-2 focus:ring-ring"
                                : "h-8 w-full rounded-[5px] bg-transparent px-2 text-right font-mono text-[13px] text-fg tabular-nums outline-none focus:bg-surface-1 focus:ring-2 focus:ring-ring"
                            }
                          />
                        </td>
                      ))}
                      <td className="border-b border-line-subtle/60 p-0.5 text-center">
                        {grid.length > 2 ? (
                          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            <IconButton
                              label={`Remove ${row[0] || `row ${r}`}`}
                              size="xs"
                              variant="ghost"
                              disabled={!canEdit}
                              onClick={() => removeRow(r)}
                            >
                              <Trash2 />
                            </IconButton>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DialogBody>
        <DialogFooter className="justify-between">
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Plus />}
            disabled={!canEdit}
            onClick={addRow}
          >
            Add row
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              flush();
              close();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
