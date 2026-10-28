"use client";

import { KNOWN_ROLES, type Node } from "@desyn/schema";
import { Select } from "@desyn/ui";
import { Lock } from "lucide-react";
import { useCommand } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { useLiveEdit } from "../lib/live.ts";
import { common, updateEach } from "../lib/ops.ts";
import { AppearanceSection } from "./appearance-section.tsx";
import {
  ChartSection,
  LinkSection,
  QrSection,
  ShapeSection,
  SvgSection,
  TableSection,
  VideoSection,
} from "./details-section.tsx";
import { useInspectorTarget } from "./hooks.ts";
import { ImageSection } from "./image-section.tsx";
import { LayoutSection } from "./layout-section.tsx";
import { PageSection } from "./page-section.tsx";
import { FillSection, StrokeSection } from "./paint-sections.tsx";
import { PositionSection } from "./position-section.tsx";
import { TextSection } from "./text-section.tsx";

/**
 * The Design tab: contextual by selection. Nothing selected shows the page; a selection shows its layer
 * header (name, semantic role), position, layout, appearance, then the sections its types need. A
 * multi-selection edits every layer at once ("Mixed" where they differ).
 */

const TYPE_LABELS: Record<string, string> = {
  frame: "Frame",
  group: "Group",
  boolean: "Boolean",
  rect: "Rectangle",
  ellipse: "Ellipse",
  polygon: "Polygon",
  star: "Star",
  line: "Line",
  path: "Vector",
  text: "Text",
  image: "Image",
  svg: "Graphic",
  video: "Video",
  audio: "Audio",
  chart: "Chart",
  table: "Table",
  qr: "QR code",
};

const NO_ROLE = "__none";

function LayerHeader({
  nodes,
  ids,
  editable,
}: {
  nodes: Node[];
  ids: string[];
  editable: boolean;
}) {
  const edit = useLiveEdit("Role");
  const unlock = useCommand("edit.toggleLock");
  const types = [...new Set(nodes.map((n) => n.type))];
  const title =
    nodes.length === 1
      ? (nodes[0] as Node).name || TYPE_LABELS[(nodes[0] as Node).type] || "Layer"
      : `${nodes.length} layers`;
  const subtitle =
    types.length === 1 ? (TYPE_LABELS[types[0] as string] ?? types[0]) : `${types.length} kinds`;
  const role = common(nodes, (n) => n.role ?? NO_ROLE);
  const locked = nodes.every((n) => n.locked);
  return (
    <div className="flex flex-col gap-2 border-b border-line-subtle px-3 pt-3 pb-3">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate font-serif text-[20px] leading-tight text-fg">{title}</span>
        <span className="shrink-0 text-2xs text-fg-muted">{subtitle}</span>
      </div>
      <Select<string>
        aria-label="Semantic role"
        size="sm"
        value={role ?? undefined}
        placeholder="Mixed roles"
        disabled={!editable}
        onValueChange={(v) =>
          edit.apply((d) => updateEach(d, ids, () => ({ role: v === NO_ROLE ? undefined : v })))
        }
        options={[
          { value: NO_ROLE, label: "No role", description: "The AI infers one from the layout" },
          ...KNOWN_ROLES.map((r) => ({ value: r, label: r })),
          ...(role && role !== NO_ROLE && !(KNOWN_ROLES as readonly string[]).includes(role)
            ? [{ value: role, label: role }]
            : []),
        ]}
        leading={<span className="text-2xs text-fg-muted">Role</span>}
      />
      {locked && editable ? (
        <button
          type="button"
          onClick={() => void unlock.run()}
          className="flex cursor-pointer items-center gap-1.5 self-start rounded-full bg-fg/6 px-2.5 py-1 text-2xs text-fg-secondary hover:bg-fg/10 hover:text-fg"
        >
          <Lock className="size-3" />
          Locked. Unlock to edit on the canvas
        </button>
      ) : null}
    </div>
  );
}

export function DesignTab(_props: SlotProps) {
  const target = useInspectorTarget();
  const { nodes, ids, editable } = target;
  if (nodes.length === 0) return <PageSection target={target} />;
  return (
    <div className="flex flex-col pb-6">
      <LayerHeader nodes={nodes} ids={ids} editable={editable} />
      <PositionSection target={target} />
      <LayoutSection target={target} />
      <AppearanceSection target={target} />
      <TextSection target={target} />
      <FillSection target={target} />
      <ImageSection target={target} />
      <StrokeSection target={target} />
      <ShapeSection target={target} />
      <ChartSection target={target} />
      <TableSection target={target} />
      <QrSection target={target} />
      <SvgSection target={target} />
      <VideoSection target={target} />
      <LinkSection target={target} />
    </div>
  );
}
