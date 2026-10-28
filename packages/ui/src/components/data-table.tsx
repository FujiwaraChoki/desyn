"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { focusRing, focusRingInset } from "../lib/styles.ts";
import { useControllableState } from "../lib/use-controllable.ts";

export type SortDirection = "asc" | "desc";
export interface SortState {
  columnId: string;
  direction: SortDirection;
}

type SortValue = string | number | boolean | Date | null | undefined;

export interface DataTableColumn<R> {
  id: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  /** Enables sorting by this column. */
  sortValue?: (row: R) => SortValue;
  align?: "left" | "center" | "right";
  /** CSS grid track, e.g. `"1fr"`, `"120px"`, `"minmax(160px, 2fr)"`. Default `1fr`. */
  width?: string;
}

export interface DataTableProps<R> {
  columns: DataTableColumn<R>[];
  rows: R[];
  getRowId: (row: R) => string;
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /** Row height in px (default 44). */
  rowHeight?: number;
  /** Max height of the scroll area; the table virtualizes beyond it. */
  maxHeight?: number;
  onRowClick?: (row: R) => void;
  selectedRowId?: string | null;
  /** Accessible table name. */
  "aria-label": string;
  empty?: ReactNode;
  className?: string;
  overscan?: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compares sort values: nulls last, numbers/dates numerically, strings naturally. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * Sortable, virtualized table (assets, members, usage). Click a header to cycle ascending →
 * descending → unsorted; headers expose `aria-sort`. Rows become keyboard-activatable with
 * `onRowClick`.
 */
export function DataTable<R>({
  columns,
  rows,
  getRowId,
  sort: sortProp,
  defaultSort = null,
  onSortChange,
  rowHeight = 44,
  maxHeight = 480,
  onRowClick,
  selectedRowId,
  "aria-label": ariaLabel,
  empty,
  className,
  overscan = 8,
}: DataTableProps<R>) {
  const [sort, setSort] = useControllableState<SortState | null>(
    sortProp,
    defaultSort,
    onSortChange,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const dir = sort.direction === "asc" ? 1 : -1;
    return rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        const va = get(a.row);
        const vb = get(b.row);
        // Keep empty values last regardless of direction.
        if (va === null || va === undefined || vb === null || vb === undefined)
          return compareSortValues(va, vb) || a.i - b.i;
        return compareSortValues(va, vb) * dir || a.i - b.i;
      })
      .map(({ row }) => row);
  }, [rows, columns, sort]);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const template = columns.map((c) => c.width ?? "1fr").join(" ");
  const gridStyle: CSSProperties = { display: "grid", gridTemplateColumns: template };
  const alignClass = (a: DataTableColumn<R>["align"]) =>
    a === "right"
      ? "justify-end text-right"
      : a === "center"
        ? "justify-center text-center"
        : "justify-start text-left";

  const cycle = (columnId: string) => {
    if (!sort || sort.columnId !== columnId) setSort({ columnId, direction: "asc" });
    else if (sort.direction === "asc") setSort({ columnId, direction: "desc" });
    else setSort(null);
  };

  return (
    <div
      role="table"
      aria-label={ariaLabel}
      aria-rowcount={sorted.length + 1}
      className={cn(
        "overflow-hidden rounded-card border border-line-subtle bg-surface-1",
        className,
      )}
    >
      <div ref={scrollRef} className="overflow-auto" style={{ maxHeight }}>
        <div
          role="rowgroup"
          className="sticky top-0 z-[1] border-b border-line-subtle bg-surface-1/95 backdrop-blur"
        >
          <div role="row" aria-rowindex={1} style={gridStyle} className="min-w-full">
            {columns.map((col) => {
              const active = sort?.columnId === col.id ? sort.direction : null;
              return (
                <div
                  key={col.id}
                  role="columnheader"
                  aria-sort={
                    active === "asc"
                      ? "ascending"
                      : active === "desc"
                        ? "descending"
                        : col.sortValue
                          ? "none"
                          : undefined
                  }
                  className={cn(
                    "flex h-9 items-center px-3 text-2xs font-medium text-fg-muted",
                    alignClass(col.align),
                  )}
                >
                  {col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => cycle(col.id)}
                      className={cn(
                        "-mx-1 flex cursor-pointer items-center gap-1 rounded-[4px] px-1 py-0.5 transition-colors hover:text-fg",
                        active && "text-fg",
                        focusRing,
                      )}
                    >
                      {col.header}
                      {active === "asc" ? (
                        <ArrowUp aria-hidden className="size-3 text-accent" />
                      ) : active === "desc" ? (
                        <ArrowDown aria-hidden className="size-3 text-accent" />
                      ) : (
                        <ChevronsUpDown aria-hidden className="size-3 opacity-50" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {sorted.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-fg-muted">{empty ?? "No rows"}</div>
        ) : (
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = sorted[v.index];
              if (row === undefined) return null;
              const id = getRowId(row);
              const selected = selectedRowId === id;
              return (
                <div
                  key={id}
                  role="row"
                  aria-rowindex={v.index + 2}
                  aria-selected={onRowClick ? selected : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  style={{
                    ...gridStyle,
                    position: "absolute",
                    top: v.start,
                    left: 0,
                    right: 0,
                    height: rowHeight,
                  }}
                  className={cn(
                    "border-b border-line-subtle/60 text-sm text-fg-secondary transition-colors last:border-b-0",
                    onRowClick && cn("cursor-pointer hover:bg-fg/4 hover:text-fg", focusRingInset),
                    selected && "bg-fg/6 text-fg",
                  )}
                >
                  {columns.map((col) => (
                    <div
                      key={col.id}
                      role="cell"
                      className={cn("flex min-w-0 items-center px-3", alignClass(col.align))}
                    >
                      <span className="min-w-0 truncate">{col.cell(row)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
