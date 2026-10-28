"use client";

import { Button, cn, IconButton, Input, Textarea } from "@desyn/ui";
import {
  ArrowLeft,
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartColumnStacked,
  ChartLine,
  ChartPie,
  ChartScatter,
  CircleDashed,
  Gauge,
  QrCode,
  Radar,
  Shapes,
  Table2,
  Triangle,
} from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { useEditor } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";
import { askAi, hasAiDock } from "../lib/ai.ts";
import {
  CHART_TYPES,
  type ElementEntry,
  FRAMES,
  GRIDS,
  LINES,
  newChart,
  newQr,
  newTable,
  SHAPES,
} from "../lib/catalog.ts";
import { useGate } from "../lib/gate.ts";
import { insertSubtree } from "../lib/insert.ts";
import { pageInk } from "../lib/page-color.ts";
import { ElementPreview } from "../ui/element-preview.tsx";
import {
  PanelBody,
  PanelSection,
  SearchField,
  Tile,
  TileGrid,
  useDebounced,
} from "../ui/primitives.tsx";
import { IconResults } from "./icon-results.tsx";

/**
 * Elements: shapes, lines, photo frames and grids, icons and stickers (Iconify), AI illustrations, charts
 * (with the data sheet), tables, QR codes. Search covers the catalog and the icon sets at once; "See all"
 * opens a section on its own.
 */

type View = "home" | "shapes" | "lines" | "frames" | "grids" | "icons" | "stickers" | "charts";

const CHART_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  column: ChartColumn,
  bar: ChartBar,
  "stacked-column": ChartColumnStacked,
  line: ChartLine,
  area: ChartArea,
  pie: ChartPie,
  donut: CircleDashed,
  scatter: ChartScatter,
  radar: Radar,
  funnel: Triangle,
  progress: Gauge,
};

function insertEntry(
  editor: EditorController,
  entry: ElementEntry,
  recolor?: (nodes: ReturnType<ElementEntry["build"]>) => void,
) {
  const nodes = entry.build();
  recolor?.(nodes);
  void insertSubtree(editor, nodes, { label: `Add ${entry.label.toLowerCase()}` });
}

function matchEntry(entry: ElementEntry, q: string): boolean {
  const hay = `${entry.label} ${entry.keywords.join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function ElementsPanel() {
  const editor = useEditor();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("home");
  const q = useDebounced(query.trim(), 300);

  if (view !== "home") {
    return <SectionView view={view} onBack={() => setView("home")} />;
  }

  const searching = q.length > 0;
  const groups: { title: string; entries: ElementEntry[]; view: View }[] = [
    { title: "Shapes", entries: SHAPES, view: "shapes" },
    { title: "Lines & arrows", entries: LINES, view: "lines" },
    { title: "Photo frames", entries: FRAMES, view: "frames" },
    { title: "Photo grids", entries: GRIDS, view: "grids" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pb-1">
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search elements"
          placeholder="Search shapes, icons, stickers…"
        />
      </div>
      <PanelBody>
        {searching ? (
          <>
            {groups.map((g) => {
              const hits = g.entries.filter((e) => matchEntry(e, q));
              return hits.length > 0 ? (
                <PanelSection key={g.title} title={g.title}>
                  <EntryGrid entries={hits} />
                </PanelSection>
              ) : null;
            })}
            <PanelSection title="Icons">
              <IconResults query={q} kind="icons" limit={24} />
            </PanelSection>
            <PanelSection title="Stickers">
              <IconResults query={q} kind="stickers" limit={12} />
            </PanelSection>
          </>
        ) : (
          <>
            {groups.map((g) => (
              <PanelSection
                key={g.title}
                title={g.title}
                action={<SeeAll onClick={() => setView(g.view)} />}
              >
                <EntryGrid entries={g.entries.slice(0, 8)} />
              </PanelSection>
            ))}
            <PanelSection title="Icons" action={<SeeAll onClick={() => setView("icons")} />}>
              <IconResults query="" kind="icons" limit={12} />
            </PanelSection>
            <PanelSection title="Stickers" action={<SeeAll onClick={() => setView("stickers")} />}>
              <IconResults query="" kind="stickers" limit={8} />
            </PanelSection>
            {hasAiDock(editor) ? <IllustrationSection /> : null}
            <PanelSection title="Charts" action={<SeeAll onClick={() => setView("charts")} />}>
              <ChartGrid limit={4} />
            </PanelSection>
            <PanelSection title="Tables">
              <TablePicker />
            </PanelSection>
            <PanelSection title="QR code">
              <QrSection />
            </PanelSection>
          </>
        )}
      </PanelBody>
    </div>
  );
}

function SeeAll({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-[6px] px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg"
    >
      See all
    </button>
  );
}

function EntryGrid({ entries }: { entries: ElementEntry[] }) {
  const editor = useEditor();
  const canEdit = editor.canEdit;
  return (
    <TileGrid min={60}>
      {entries.map((e) => (
        <Tile key={e.id} label={e.label} disabled={!canEdit} onClick={() => insertEntry(editor, e)}>
          <ElementPreview spec={e.preview} />
        </Tile>
      ))}
    </TileGrid>
  );
}

function SectionView({ view, onBack }: { view: Exclude<View, "home">; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 300);
  const titles: Record<Exclude<View, "home">, string> = {
    shapes: "Shapes",
    lines: "Lines & arrows",
    frames: "Photo frames",
    grids: "Photo grids",
    icons: "Icons",
    stickers: "Stickers",
    charts: "Charts",
  };
  const entries: Partial<Record<Exclude<View, "home">, ElementEntry[]>> = {
    shapes: SHAPES,
    lines: LINES,
    frames: FRAMES,
    grids: GRIDS,
  };
  const list = entries[view];
  const searchable = view === "icons" || view === "stickers" || !!list;
  let body: ReactNode;
  if (view === "icons" || view === "stickers") {
    body = <IconResults query={q} kind={view} limit={96} showSets />;
  } else if (view === "charts") {
    body = <ChartGrid />;
  } else if (list) {
    const hits = q ? list.filter((e) => matchEntry(e, q)) : list;
    body =
      hits.length > 0 ? (
        <EntryGrid entries={hits} />
      ) : (
        <p className="py-8 text-center text-xs text-fg-muted">Nothing matches “{q}”.</p>
      );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
        <IconButton label="Back to elements" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft />
        </IconButton>
        <span className="text-sm text-fg">{titles[view]}</span>
      </div>
      {searchable ? (
        <div className="shrink-0 px-3 pb-1">
          <SearchField
            value={query}
            onChange={setQuery}
            label={`Search ${titles[view].toLowerCase()}`}
            placeholder={`Search ${titles[view].toLowerCase()}…`}
            autoFocus
          />
        </div>
      ) : null}
      <PanelBody className="pt-2">{body}</PanelBody>
    </div>
  );
}

function ChartGrid({ limit }: { limit?: number }) {
  const editor = useEditor();
  const gate = useGate();
  const types = limit ? CHART_TYPES.slice(0, limit) : CHART_TYPES;
  return (
    <TileGrid min={68}>
      {types.map((t) => {
        const Icon = CHART_ICONS[t.id] ?? ChartColumn;
        return (
          <Tile
            key={t.id}
            label={`${t.label} chart`}
            caption
            pro={gate.locked("charts")}
            ratio={1.25}
            disabled={!editor.canEdit}
            onClick={async () => {
              if (!gate.check("charts")) return;
              const chart = newChart(t.id);
              // Labels and legends read on the page (dark pages get light text).
              chart.options.textColor = pageInk(editor);
              const id = await insertSubtree(editor, [chart], { label: "Add chart" });
              if (id) editor.openModal("chart-data", { nodeId: id });
            }}
          >
            <Icon className="size-6 text-fg-secondary transition-colors group-hover/tile:text-accent" />
          </Tile>
        );
      })}
    </TileGrid>
  );
}

const MAX_TABLE = 8;

/** Hover a size on the grid, click to insert a table of that many rows and columns. */
function TablePicker() {
  const editor = useEditor();
  const gate = useGate();
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 3, c: 3 });
  const insert = (rows: number, cols: number) => {
    if (!gate.check("tables")) return;
    const table = newTable(rows, cols);
    const ink = pageInk(editor);
    if (ink !== "#171717") {
      table.defaultStyle = { ...table.defaultStyle, fills: [{ type: "solid", color: ink }] };
      table.borderColor = "#ffffff33";
    }
    void insertSubtree(editor, [table], { label: "Add table" });
  };
  const cells = useMemo(() => {
    const out: { r: number; c: number }[] = [];
    for (let r = 1; r <= MAX_TABLE; r++) for (let c = 1; c <= MAX_TABLE; c++) out.push({ r, c });
    return out;
  }, []);
  return (
    <div className="flex items-start gap-3">
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add form chrome to a size picker */}
      <div
        role="group"
        aria-label="Table size"
        className="grid shrink-0 gap-[3px] rounded-[10px] bg-surface-2 p-2"
        style={{ gridTemplateColumns: `repeat(${MAX_TABLE}, 14px)` }}
        onPointerLeave={() => setHover({ r: 3, c: 3 })}
      >
        {cells.map(({ r, c }) => {
          const on = r <= hover.r && c <= hover.c;
          return (
            <button
              key={`${r}-${c}`}
              type="button"
              aria-label={`${r} by ${c} table`}
              disabled={!editor.canEdit}
              onPointerEnter={() => setHover({ r, c })}
              onFocus={() => setHover({ r, c })}
              onClick={() => insert(r, c)}
              className={cn(
                "size-3.5 cursor-pointer rounded-[3px] border transition-colors duration-75 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-accent bg-accent-tint" : "border-line-subtle bg-surface-1",
              )}
            />
          );
        })}
      </div>
      <div className="flex min-w-0 flex-col gap-1 pt-1">
        <span className="font-serif text-[28px] leading-none text-fg tabular-nums">
          {hover.r} × {hover.c}
        </span>
        <span className="text-2xs text-fg-muted">rows × columns</span>
        <Button
          size="xs"
          variant="secondary"
          className="mt-2 self-start"
          leadingIcon={<Table2 />}
          disabled={!editor.canEdit}
          onClick={() => insert(hover.r, hover.c)}
        >
          Add table
        </Button>
        {gate.locked("tables") ? (
          <span className="text-2xs text-accent-text">Pro feature</span>
        ) : null}
      </div>
    </div>
  );
}

function QrSection() {
  const editor = useEditor();
  const gate = useGate();
  const [data, setData] = useState("");
  const value = data.trim();
  const add = () => {
    if (!value || !gate.check("qr")) return;
    const node = newQr(value) as ReturnType<typeof newQr> & { fg: string; bg: string };
    const ink = pageInk(editor);
    if (ink !== "#171717") {
      node.fg = "#fafafa";
      node.bg = "#00000000";
    }
    void insertSubtree(editor, [node], { label: "Add QR code" });
    setData("");
  };
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <Input
        size="sm"
        value={data}
        maxLength={2000}
        aria-label="QR code link or text"
        placeholder="https://your.site"
        leading={<QrCode className="size-3.5" />}
        onChange={(e) => setData(e.target.value)}
        className="flex-1"
      />
      <Button type="submit" size="sm" variant="secondary" disabled={!value || !editor.canEdit}>
        Add
      </Button>
    </form>
  );
}

function IllustrationSection() {
  const editor = useEditor();
  const [prompt, setPrompt] = useState("");
  const text = prompt.trim();
  return (
    <PanelSection title="Illustrations">
      <div className="relative overflow-hidden rounded-[12px] bg-surface-2 p-3">
        <div className="relative flex flex-col gap-2">
          <p className="font-serif text-lg leading-tight text-fg">
            draw it with <em className="text-accent">ai</em>
          </p>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            minRows={2}
            maxLength={600}
            aria-label="Describe the illustration"
            placeholder="A flat illustration of a sunrise over hills"
            className="text-xs"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!text || !editor.canEdit}
            onClick={() => {
              if (
                askAi(editor, `Create a vector illustration and place it on this page: ${text}`, {
                  autoStart: true,
                  scope: "design",
                })
              )
                setPrompt("");
            }}
          >
            Generate illustration
          </Button>
        </div>
      </div>
    </PanelSection>
  );
}

export const ElementsIcon = Shapes;
