"use client";

import { fromPx, type PageNode, toPx, UNITS, type Unit } from "@desyn/schema";
import { Button, Select, Switch, Textarea } from "@desyn/ui";
import { Grid2x2, Minus, Plus, Scaling, Trash2 } from "lucide-react";
import { useCommand, useEditor } from "../../context.tsx";
import { assetOps } from "../lib/insert.ts";
import { useLiveEdit } from "../lib/live.ts";
import { round2, updateEach } from "../lib/ops.ts";
import { InspectorSection, MiniButton, Row } from "../ui/primitives.tsx";
import { Num } from "./fields.tsx";
import { FillList } from "./fill-list.tsx";
import type { InspectorTarget } from "./hooks.ts";

/** Page settings when nothing is selected: size, background, bleed, layout grid, guides, timing, notes. */

const TRANSITIONS: NonNullable<PageNode["transition"]>["kind"][] = [
  "none",
  "fade",
  "slide",
  "push",
  "zoom",
  "dissolve",
];

export function PageSection({ target }: { target: InspectorTarget }) {
  const editor = useEditor();
  const { page, editable } = target;
  const bg = useLiveEdit("Page background");
  const misc = useLiveEdit("Page");
  const grid = useCommand("view.toggleLayoutGrid");
  if (!page) return null;
  const ids = [page.id];
  const unit = page.unit;
  const show = (px: number) => round2(fromPx(px, unit));
  const disabled = !editable;
  const g = page.grid;

  return (
    <>
      <InspectorSection
        title="Page"
        actions={
          editable ? (
            <MiniButton
              label="Resize page"
              onClick={() => editor.openModal("page-resize", { pageId: page.id })}
            >
              <Scaling />
            </MiniButton>
          ) : null
        }
      >
        <div className="flex items-center gap-1.5">
          <Num
            label="W"
            aria-label="Page width"
            value={show(page.width)}
            disabled={disabled}
            min={show(1)}
            onCommit={(v) =>
              editor.openModal("page-resize", { pageId: page.id, width: toPx(v, unit) })
            }
          />
          <Num
            label="H"
            aria-label="Page height"
            value={show(page.height)}
            disabled={disabled}
            min={show(1)}
            onCommit={(v) =>
              editor.openModal("page-resize", { pageId: page.id, height: toPx(v, unit) })
            }
          />
          <Select<Unit>
            aria-label="Page unit"
            size="sm"
            value={unit}
            disabled={disabled}
            onValueChange={(u) => misc.apply((d) => updateEach(d, ids, () => ({ unit: u })))}
            options={UNITS.map((u) => ({ value: u, label: u }))}
            className="w-[64px] shrink-0"
          />
        </div>
        {unit !== "px" || page.bleed > 0 ? (
          <Row label="Bleed">
            <Num
              label="B"
              aria-label="Bleed"
              unit={unit}
              min={0}
              value={show(page.bleed)}
              disabled={disabled}
              onCommit={(v) =>
                misc.apply((d) => updateEach(d, ids, () => ({ bleed: round2(toPx(v, unit)) })))
              }
            />
          </Row>
        ) : null}
      </InspectorSection>
      <InspectorSection title="Background">
        <FillList
          label="Background"
          fills={page.background}
          defaultColor="#ffffff"
          onPreview={(fills) =>
            bg.preview((d) => updateEach(d, ids, () => ({ background: fills })))
          }
          onCommit={(fills, assets) =>
            bg.commit((d) => [
              ...(assets?.length ? assetOps(d, assets) : []),
              ...updateEach(d, ids, () => ({ background: fills })),
            ])
          }
        />
      </InspectorSection>
      <InspectorSection
        title="Layout grid"
        actions={
          <>
            {g ? (
              <MiniButton
                label={grid.checked ? "Hide layout grid" : "Show layout grid"}
                active={!!grid.checked}
                onClick={() => void grid.run()}
              >
                <Grid2x2 />
              </MiniButton>
            ) : null}
            <MiniButton
              label={g ? "Remove layout grid" : "Add layout grid"}
              disabled={disabled}
              onClick={() =>
                misc.apply((d) =>
                  updateEach(d, ids, (n) => ({
                    grid: g
                      ? undefined
                      : {
                          columns: 12,
                          gutter: Math.round((n.width / 1080) * 24),
                          margin: Math.round((n.width / 1080) * 64),
                        },
                  })),
                )
              }
            >
              {g ? <Minus /> : <Plus />}
            </MiniButton>
          </>
        }
        empty={!g}
      >
        {g ? (
          <div className="grid grid-cols-3 gap-1.5">
            <Num
              label="Col"
              aria-label="Grid columns"
              min={1}
              max={48}
              step={1}
              value={g.columns}
              disabled={disabled}
              onCommit={(v) =>
                misc.apply((d) =>
                  updateEach(d, ids, () => ({ grid: { ...g, columns: Math.round(v) } })),
                )
              }
            />
            <Num
              label="Gut"
              aria-label="Gutter"
              min={0}
              value={g.gutter}
              disabled={disabled}
              onCommit={(v) =>
                misc.apply((d) => updateEach(d, ids, () => ({ grid: { ...g, gutter: v } })))
              }
            />
            <Num
              label="Mar"
              aria-label="Margin"
              min={0}
              value={g.margin}
              disabled={disabled}
              onCommit={(v) =>
                misc.apply((d) => updateEach(d, ids, () => ({ grid: { ...g, margin: v } })))
              }
            />
          </div>
        ) : null}
      </InspectorSection>
      {page.guides && page.guides.length > 0 ? (
        <InspectorSection
          title={`Guides (${page.guides.length})`}
          actions={
            <MiniButton
              label="Remove all guides"
              disabled={disabled}
              onClick={() => misc.apply((d) => updateEach(d, ids, () => ({ guides: undefined })))}
            >
              <Trash2 />
            </MiniButton>
          }
          empty
        />
      ) : null}
      <InspectorSection title="Timing">
        <div className="grid grid-cols-2 gap-1.5">
          <Num
            label="Dur"
            aria-label="Page duration"
            unit="s"
            min={0.5}
            max={600}
            step={0.5}
            value={page.durationMs ? round2(page.durationMs / 1000) : null}
            placeholder="Auto"
            disabled={disabled}
            onCommit={(v) =>
              misc.apply((d) => updateEach(d, ids, () => ({ durationMs: Math.round(v * 1000) })))
            }
          />
          <Select<NonNullable<PageNode["transition"]>["kind"]>
            aria-label="Transition"
            size="sm"
            value={page.transition?.kind ?? "none"}
            disabled={disabled}
            onValueChange={(kind) =>
              misc.apply((d) =>
                updateEach(d, ids, () => ({
                  transition:
                    kind === "none"
                      ? undefined
                      : { kind, durationMs: page.transition?.durationMs ?? 500 },
                })),
              )
            }
            options={TRANSITIONS.map((t) => ({
              value: t,
              label: t === "none" ? "No transition" : t[0]?.toUpperCase() + t.slice(1),
            }))}
          />
        </div>
        {page.transition ? (
          <Row label="Transition">
            <Num
              label="ms"
              aria-label="Transition duration"
              min={50}
              max={5000}
              step={50}
              value={page.transition.durationMs}
              disabled={disabled}
              onCommit={(v) =>
                misc.apply((d) =>
                  updateEach(d, ids, () => ({
                    transition: {
                      ...(page.transition as NonNullable<PageNode["transition"]>),
                      durationMs: Math.round(v),
                    },
                  })),
                )
              }
            />
          </Row>
        ) : null}
      </InspectorSection>
      <InspectorSection title="Notes">
        <Textarea
          key={page.id}
          aria-label="Speaker notes"
          placeholder="Speaker notes for presenting"
          defaultValue={page.notes ?? ""}
          disabled={disabled}
          maxLength={10_000}
          autoResize
          minRows={2}
          maxRows={10}
          className="text-xs"
          onBlur={(e) => {
            const notes = e.target.value.trim();
            if ((page.notes ?? "") !== notes)
              misc.apply((d) => updateEach(d, ids, () => ({ notes: notes || undefined })));
          }}
        />
      </InspectorSection>
      <div className="px-3 py-3">
        <Switch
          size="sm"
          label="Clip content to the page"
          checked={page.clip}
          disabled={disabled}
          onCheckedChange={(v) => misc.apply((d) => updateEach(d, ids, () => ({ clip: v })))}
        />
      </div>
      {editable ? (
        <div className="px-3 pb-4">
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            leadingIcon={<Scaling />}
            onClick={() => editor.openModal("page-resize", { pageId: page.id })}
          >
            Resize page
          </Button>
        </div>
      ) : null}
    </>
  );
}
