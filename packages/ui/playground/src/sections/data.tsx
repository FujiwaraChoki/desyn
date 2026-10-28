import { Badge, DataTable, type DataTableColumn, Logo, Orbs, SunGlow, SunMark } from "@desyn/ui";
import { FileImage, FileType2, Film, Shapes } from "lucide-react";
import { useState } from "react";
import { type AssetRow, assetRows, formatBytes } from "../data.ts";
import { LayersPanel } from "../editor.tsx";
import { Row, Showcase, Stack } from "../showcase.tsx";

const KIND_ICON = {
  Image: <FileImage className="size-3.5" />,
  SVG: <Shapes className="size-3.5" />,
  Font: <FileType2 className="size-3.5" />,
  Video: <Film className="size-3.5" />,
};

const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

const columns: DataTableColumn<AssetRow>[] = [
  {
    id: "name",
    header: "Name",
    width: "minmax(160px, 2fr)",
    sortValue: (r) => r.name,
    cell: (r) => (
      <span className="flex items-center gap-2 text-fg">
        <span className="text-fg-muted">{KIND_ICON[r.kind]}</span>
        <span className="truncate">{r.name}</span>
      </span>
    ),
  },
  {
    id: "kind",
    header: "Kind",
    width: "80px",
    sortValue: (r) => r.kind,
    cell: (r) => <Badge size="sm">{r.kind}</Badge>,
  },
  {
    id: "size",
    header: "Size",
    width: "80px",
    align: "right",
    sortValue: (r) => r.size,
    cell: (r) => <span className="tabular-nums">{formatBytes(r.size)}</span>,
  },
  {
    id: "updated",
    header: "Updated",
    width: "80px",
    align: "right",
    sortValue: (r) => r.updated,
    cell: (r) => dateFormat.format(r.updated),
  },
];

function AssetsTable() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <DataTable
      aria-label="Uploads"
      columns={columns}
      rows={assetRows}
      getRowId={(r) => r.id}
      defaultSort={{ columnId: "updated", direction: "desc" }}
      onRowClick={(r) => setSelected(r.id)}
      selectedRowId={selected}
      maxHeight={300}
    />
  );
}

export function DataSection() {
  return (
    <Showcase
      id="data"
      eyebrow="Data"
      title={
        <>
          long lists, <em>light</em> as air
        </>
      }
      description="The virtualized layers tree (drag to reorder or nest, F2 or double-click to rename, lock and hide toggles) and a sortable, virtualized table of 240 rows."
    >
      {() => (
        <Stack>
          <Row label="Tree" className="block">
            <div className="h-72 rounded-card border border-line-subtle bg-surface-1">
              <LayersPanel />
            </div>
          </Row>
          <Row label="Data table" className="block">
            <AssetsTable />
          </Row>
        </Stack>
      )}
    </Showcase>
  );
}

export function BrandSection() {
  return (
    <Showcase
      id="brand"
      eyebrow="Brand"
      title={
        <>
          the sun, <em>rising</em>
        </>
      }
      description="Wordmark and sun mark, plus the atmospheric orbs and glow used behind heroes and empty canvases."
    >
      {() => (
        <Stack>
          <Row label="Logo">
            <Logo size={32} />
            <Logo variant="wordmark" size={24} />
            <SunMark size={32} title="Desyn" />
          </Row>
          <div className="relative flex h-56 items-center justify-center overflow-hidden rounded-panel border border-line-subtle bg-background">
            <Orbs scale={0.5} />
            <SunGlow width={420} height={200} />
            <p className="relative font-serif text-[44px] leading-none text-fg sm:text-[56px]">
              design at the speed of{" "}
              <em className="text-accent drop-shadow-[0_0_20px_var(--accent-glow)]">light</em>.
            </p>
          </div>
        </Stack>
      )}
    </Showcase>
  );
}
